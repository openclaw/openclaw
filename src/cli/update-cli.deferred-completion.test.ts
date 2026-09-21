import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { listUpdateRuns } from "../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { VERSION } from "../version.js";
import {
  installDeferredCompletionFixture,
  readPackageVersion,
  updateGitCheckout,
  runCommandWithTimeout,
  readConfigFileSnapshot,
  defaultRuntime,
  runExec,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  spawn,
  runPostCorePluginConvergenceSpy,
  loadInstalledPluginIndexInstallRecords,
  pathExists,
  resolveGatewayInstallEntrypoint,
  replaceConfigFile,
  mutateConfigFileWithRetry,
  updateFinalizeCommand,
  ExitError,
  observeUpdateGatewayReadiness,
} from "./update-cli.deferred-completion.test-support.js";

describe("update-cli child-owned deferred completion", () => {
  const {
    runPostCoreCommand,
    lastNpmPluginUpdateCall,
    postCoreConvergenceResult,
    syncPluginCall,
    lastWriteJsonCall,
    mockNpmPluginOutcomes,
    getErrorOutput,
    getLogOutput,
    mockNoopPostUpdatePluginConvergence,
    createCaseDir,
    writeJsonFixture,
    FRESH_POST_UPDATE_ENTRYPOINT,
    configSnapshot,
    stableConfig,
    baseConfig,
    mockFileBackedPathExists,
    stableWhatsAppConfig,
    mockPostDoctorSnapshot,
    runPostCoreUpdate,
    lastReplaceConfigCall,
    setupPostCoreConfigFixture,
  } = installDeferredCompletionFixture();
  const mockLegacyPostCoreDoctor = () => {
    // Legacy parents run migration Doctor before the child probes the parent's start time.
    vi.mocked(runExec).mockImplementationOnce(async (file, args) => {
      expect(file).toBe(process.execPath);
      expect(args).toEqual([
        path.join(process.cwd(), "dist", "index.js"),
        "doctor",
        "--repair",
        "--non-interactive",
        "--no-workspace-suggestions",
        "--yes",
      ]);
      return { stdout: "", stderr: "" };
    });
  };

  it("legacy post-core resume completes Doctor without running core update", async () => {
    readPackageVersion.mockResolvedValue("2026.9.4");
    await runPostCoreCommand({ restart: false }, { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" });

    expect(updateGitCheckout).not.toHaveBeenCalled();
    const installCall = (
      vi.mocked(runCommandWithTimeout).mock.calls as unknown as Array<[string[], unknown]>
    ).find(([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");
    expect(installCall).toBeUndefined();
    expect(
      vi
        .mocked(readConfigFileSnapshot)
        .mock.calls.some(
          ([options]) =>
            options?.skipPluginValidation === true && options.suppressFutureVersionWarning === true,
        ),
    ).toBe(true);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
    // No ownership declaration preserves the shipped child-owned Doctor completion contract.
    expect(
      vi
        .mocked(runExec)
        .mock.calls.filter(([, args]) => args[1] === "doctor")
        .map(([, args]) => args[1]),
    ).toEqual(["doctor"]);
    expect(syncPluginsForUpdateChannel).toHaveBeenCalledTimes(1);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(lastNpmPluginUpdateCall()).toMatchObject({
      coreVersion: "2026.9.4",
      versionBoundPluginIds: new Set(["codex"]),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a post-core run missing from history before Doctor or plugin effects", async () => {
    const ledger = await import("../infra/update-run-ledger.js");
    const sourceRuntime = await import("./update-cli/update-command-runtime.js");
    const preparation = vi
      .spyOn(sourceRuntime, "completeSourceUpdateRuntime")
      .mockRejectedValue(new Error("Missing-run regression reached runtime preparation."));
    const runId = "53e56de0-a951-4b3d-af1a-9e4f1ac5a069";
    expect(ledger.getUpdateRun(runId)).toBeUndefined();
    const history = ledger.listUpdateRuns({ limit: 100 });
    readPackageVersion.mockResolvedValue("2026.9.4");

    const failure = await runPostCoreCommand(
      { restart: false, json: true },
      {
        OPENCLAW_UPDATE_RUN_ID: runId,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "beta",
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(preparation).not.toHaveBeenCalled();
    expect(failure).toMatchObject({
      name: "UpdateCommandRecoveryPendingError",
      message: "Post-core update run is unavailable; resume cannot verify its owner.",
    });

    expect(vi.mocked(runExec).mock.calls.some(([, args]) => args.includes("doctor"))).toBe(false);
    expect(syncPluginsForUpdateChannel).not.toHaveBeenCalled();
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(0);
    expect(ledger.listUpdateRuns({ limit: 100 })).toEqual(history);
  });

  it("completes convergence-only post-core changes for a legacy parent", async () => {
    runPostCorePluginConvergenceSpy.mockResolvedValueOnce(
      postCoreConvergenceResult({
        changes: ["Repaired configured plugin install records."],
      }),
    );

    await runPostCoreCommand({ restart: false, json: true });

    expect(syncPluginCall()?.config).toBeDefined();
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    // Without a parent ownership declaration, the child runs Doctor and final validation.
    expect(
      vi
        .mocked(runExec)
        .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? ""))
        .map(([, args]) => args[1]),
    ).toEqual(["doctor", "doctor", "config"]);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "ok",
      postUpdate: { plugins: { changed: true } },
    });
  });

  it("keeps Doctor diagnostics outside JSON during legacy post-core resume", async () => {
    mockNpmPluginOutcomes([], true);
    vi.mocked(runExec).mockResolvedValueOnce({ stdout: "Migration Doctor output\n", stderr: "" });

    await runPostCoreCommand({ json: true, restart: false });

    // Without a parent ownership declaration, the child runs Doctor and final validation.
    expect(
      vi
        .mocked(runExec)
        .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? ""))
        .map(([, args]) => args[1]),
    ).toEqual(["doctor", "doctor", "config"]);
    expect(getErrorOutput()).toContain("Migration Doctor output");
    expect(JSON.parse(getLogOutput())).toEqual(lastWriteJsonCall());
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        postUpdate: expect.objectContaining({
          plugins: expect.objectContaining({ changed: true }),
        }),
      }),
    );
  });

  it("post-core resume mode uses the parent install records snapshot for missing payload warnings", async () => {
    mockNoopPostUpdatePluginConvergence();
    const resultDir = createCaseDir("openclaw-post-core-records");
    const recordsPath = path.join(resultDir, "plugin-install-records.json");
    const installPath = path.join(resultDir, "demo-plugin");
    await fs.mkdir(installPath, { recursive: true });
    await writeJsonFixture(recordsPath, {
      demo: { source: "npm", spec: "@openclaw/demo@1.0.0", installPath },
    });
    pathExists.mockImplementation(async (candidate: string) => candidate === installPath);
    // Child-owned completion needs the installed candidate's Doctor entrypoint.
    vi.mocked(resolveGatewayInstallEntrypoint).mockImplementation(async (root) => {
      expect(root).toBe(process.cwd());
      return FRESH_POST_UPDATE_ENTRYPOINT;
    });

    await runPostCoreCommand(
      { json: true, restart: false },
      { OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: recordsPath },
    );

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.[0]?.reason).toContain(
      "package.json is missing",
    );
    const updateCall = lastNpmPluginUpdateCall() as { skipIds?: Set<string> } | undefined;
    expect(updateCall?.skipIds?.has("demo")).toBe(true);
  });

  it.each(
    [
      { touchedVersion: "9999.1.1", valid: true, writes: true },
      { touchedVersion: VERSION, valid: true, writes: false },
      { touchedVersion: "9999.1.1", valid: false, writes: false },
    ].flatMap(({ touchedVersion, valid, writes }) =>
      ["resume", "finalize"].map((mode) => ({ touchedVersion, valid, writes, mode })),
    ),
  )(
    "$mode commits a validated downgrade without changing channels ($touchedVersion, valid=$valid)",
    async ({ touchedVersion, valid, writes, mode }) => {
      const config = stableConfig({ meta: { lastTouchedVersion: touchedVersion } });
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config, { valid }));

      if (mode === "resume") {
        await runPostCoreCommand({ restart: false, json: true });
        // Legacy child completion does not change which downgrade configs may be written.
        expect(
          vi
            .mocked(runExec)
            .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? ""))
            .map(([, args]) => args[1]),
        ).toEqual(valid ? ["doctor", "config"] : ["doctor"]);
      } else {
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
        if (valid) {
          await updateFinalizeCommand({ json: true, yes: true });
        } else {
          await expect(updateFinalizeCommand({ json: true, yes: true })).rejects.toEqual(
            new ExitError(1),
          );
          expect(observeUpdateGatewayReadiness).toHaveBeenCalledOnce();
          const recorded = listUpdateRuns({ limit: 1 })[0];
          expect(recorded?.status).toBe("failed");
          expect(recorded?.verification).toEqual({
            serviceRunning: false,
            port: 18789,
            pluginErrors: [],
            channelsReady: false,
            settled: false,
            readyz: false,
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          });
          expect(
            recorded?.steps.filter((step) => step.step === "gateway recovery verification"),
          ).toEqual([
            {
              step: "gateway recovery verification",
              status: "failed",
              exitCode: 1,
              detail: "Exit code: 1",
              failureFacts: [
                { check: "settled", code: "stopped-free", message: "Gateway did not settle." },
              ],
            },
          ]);
        }
      }

      if (writes) {
        expect(replaceConfigFile).toHaveBeenCalledExactlyOnceWith({ nextConfig: config });
        expect(mutateConfigFileWithRetry).toHaveBeenCalledExactlyOnceWith({
          mutate: expect.any(Function),
          writeOptions: {
            assertCurrent: expect.any(Function),
            beforeCommit: expect.any(Function),
            observe: false,
          },
        });
        if (mode === "finalize") {
          expect(
            vi.mocked(mutateConfigFileWithRetry).mock.calls[0]?.[0].writeOptions?.assertCurrent,
          ).toThrow("Update operation ownership has closed.");
          expect(
            vi.mocked(mutateConfigFileWithRetry).mock.calls[0]?.[0].writeOptions?.beforeCommit,
          ).toThrow("Update operation ownership has closed.");
        }
      } else {
        expect(replaceConfigFile).not.toHaveBeenCalled();
      }
      expect(updateGitCheckout).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "reports a completed missing-payload repair instead of the later bulk skip (json=%s)",
    async (json) => {
      mockNoopPostUpdatePluginConvergence();
      const installPath = createCaseDir("openclaw-repaired-plugin-summary");
      fsSync.mkdirSync(installPath, { recursive: true });
      const records = {
        demo: { source: "npm", spec: "@example/demo", installPath, version: "1.0.0" },
      } satisfies Record<string, PluginInstallRecord>;
      const config = {
        ...baseConfig,
        plugins: { ...baseConfig.plugins, entries: { demo: { enabled: true } } },
      } satisfies OpenClawConfig;
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
      loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mockFileBackedPathExists();
      // Child-owned completion needs the installed candidate's Doctor entrypoint.
      vi.mocked(resolveGatewayInstallEntrypoint).mockImplementation(async (root) => {
        expect(root).toBe(process.cwd());
        return FRESH_POST_UPDATE_ENTRYPOINT;
      });
      const repaired = {
        pluginId: "demo",
        status: "updated" as const,
        message: 'Repaired plugin "demo".',
      };
      updateNpmInstalledPlugins.mockImplementation(async ({ config: current, skipIds }) => {
        if (skipIds?.has("demo")) {
          return {
            config: current,
            changed: false,
            outcomes: [
              {
                pluginId: "demo",
                status: "skipped",
                message: 'Skipping "demo" (already updated).',
              },
            ],
          };
        }
        fsSync.writeFileSync(
          path.join(installPath, "package.json"),
          JSON.stringify({
            name: "@example/demo",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        fsSync.writeFileSync(
          path.join(installPath, "openclaw.plugin.json"),
          JSON.stringify({ id: "demo", configSchema: { type: "object" } }),
        );
        fsSync.writeFileSync(path.join(installPath, "index.js"), "module.exports = {};\n");
        return { config: current, changed: true, outcomes: [repaired] };
      });
      runPostCorePluginConvergenceSpy.mockResolvedValueOnce({
        ...postCoreConvergenceResult(),
        installRecords: records,
      });

      await runPostCoreCommand({ yes: true, json, restart: false });

      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      if (json) {
        const result = lastWriteJsonCall() as UpdateRunResult | undefined;
        expect(result?.status).toBe("ok");
        expect(result?.postUpdate?.plugins?.status).toBe("ok");
        expect(result?.postUpdate?.plugins?.npm?.outcomes.at(-1)).toEqual(repaired);
      } else {
        expect(getLogOutput()).toContain("Plugin updates: 1 updated, 0 unchanged.");
        expect(getLogOutput()).not.toContain("1 skipped");
      }
    },
  );

  it.each([
    {
      name: "does not restore stale backup channels when current pre-update snapshot has none",
      prepare: async (configPath: string, preUpdateConfig: OpenClawConfig) => {
        await writeJsonFixture(`${configPath}.pre-update`, stableConfig());
        await writeJsonFixture(`${configPath}.bak`, preUpdateConfig);
        return {};
      },
    },
    {
      name: "ignores pre-update channel snapshots older than the current update attempt",
      prepare: async (configPath: string, preUpdateConfig: OpenClawConfig) => {
        const updateStartedAtMs = Date.now();
        const staleTime = new Date(updateStartedAtMs - 60_000);
        for (const suffix of [".pre-update", ".bak"]) {
          const snapshotPath = `${configPath}${suffix}`;
          await writeJsonFixture(snapshotPath, preUpdateConfig);
          await fs.utimes(snapshotPath, staleTime, staleTime);
        }
        return { OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(updateStartedAtMs) };
      },
    },
    {
      name: "ignores disk fallback snapshots when the update attempt start is unknown",
      prepare: async (configPath: string, preUpdateConfig: OpenClawConfig) => {
        for (const suffix of [".pre-update", ".bak"]) {
          await writeJsonFixture(`${configPath}${suffix}`, preUpdateConfig);
        }
        mockLegacyPostCoreDoctor();
        vi.mocked(runExec).mockRejectedValueOnce(new Error("ps unavailable"));
        return {};
      },
    },
    {
      name: "ignores stale pre-update channel snapshots during post-core resume",
      preserveParsed: true,
      prepare: async (configPath: string) => {
        const staleConfig = {
          channels: { whatsapp: { enabled: true } },
        } as OpenClawConfig;
        const snapshotPath = `${configPath}.pre-update`;
        await writeJsonFixture(snapshotPath, staleConfig);
        const staleTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
        await fs.utimes(snapshotPath, staleTime, staleTime);
        return {};
      },
    },
  ])("$name", async ({ prepare, preserveParsed = false }) => {
    const tempDir = createCaseDir("openclaw-update");
    const configPath = path.join(tempDir, "openclaw.json");
    const preUpdateConfig = stableWhatsAppConfig();
    const postDoctorConfig = stableConfig();
    await fs.mkdir(tempDir, { recursive: true });
    const env = await prepare(configPath, preUpdateConfig);
    await writeJsonFixture(configPath, postDoctorConfig);
    mockPostDoctorSnapshot(configPath, postDoctorConfig, { preserveParsed });
    mockNoopPostUpdatePluginConvergence();

    await runPostCoreUpdate(env);

    expect(syncPluginCall()?.config?.channels?.whatsapp).toBeUndefined();
    expect(lastReplaceConfigCall()).toBeUndefined();
  });

  it("uses the Windows parent process start time for old post-core parents", async () => {
    const parentStartedAtMs = Date.now() - 1_000;
    const preUpdateConfig = stableWhatsAppConfig();
    const postDoctorConfig = stableConfig();
    await setupPostCoreConfigFixture({ preUpdateConfig, postDoctorConfig });
    mockLegacyPostCoreDoctor();
    vi.mocked(runExec).mockImplementationOnce(async (file, commandArgs) => {
      expect(file).toBe("powershell.exe");
      expect(commandArgs).toContain("-NonInteractive");
      return {
        stdout: new Date(parentStartedAtMs).toISOString(),
        stderr: "",
      };
    });
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "win32",
    });
    try {
      await runPostCoreUpdate();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }

    expect(syncPluginCall()?.config?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    expect(lastReplaceConfigCall()).toBeDefined();
  });
});
