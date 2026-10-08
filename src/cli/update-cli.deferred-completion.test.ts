import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { listUpdateRuns } from "../infra/update-run-ledger.js";
import {
  installDeferredCompletionFixture,
  readPackageVersion,
  readConfigFileSnapshot,
  defaultRuntime,
  runExec,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  runPostCorePluginConvergenceSpy,
  loadInstalledPluginIndexInstallRecords,
  resolveGatewayInstallEntrypoint,
  replaceConfigFile,
  mutateConfigFileWithRetry,
  updateGitCheckout,
  updateFinalizeCommand,
  ExitError,
  observeUpdateGatewayReadiness,
} from "./update-cli.deferred-completion.test-support.js";

describe("update-cli child-owned deferred completion", () => {
  const {
    runPostCoreCommand,
    postCoreConvergenceResult,
    syncPluginCall,
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
  } = installDeferredCompletionFixture();

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

  it.each([
    { touchedVersion: "9999.1.1", valid: false, writes: false, mode: "finalize" },
    { touchedVersion: "9999.1.1", valid: true, writes: true, mode: "finalize" },
  ])(
    "$mode commits a validated downgrade without changing channels ($touchedVersion, valid=$valid)",
    async ({ touchedVersion, valid, writes }) => {
      const config = stableConfig({ meta: { lastTouchedVersion: touchedVersion } });
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config, { valid }));

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
            detail: "Exit code: 1; Gateway did not settle.",
            failureFacts: [
              { check: "settled", code: "stopped-free", message: "Gateway did not settle." },
            ],
          },
        ]);
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

        expect(
          vi.mocked(mutateConfigFileWithRetry).mock.calls[0]?.[0].writeOptions?.assertCurrent,
        ).toThrow("Update operation ownership has closed.");
        expect(
          vi.mocked(mutateConfigFileWithRetry).mock.calls[0]?.[0].writeOptions?.beforeCommit,
        ).toThrow("Update operation ownership has closed.");
      } else {
        expect(replaceConfigFile).not.toHaveBeenCalled();
      }
      expect(updateGitCheckout).not.toHaveBeenCalled();
    },
  );

  it("reports a completed missing-payload repair instead of the later bulk skip", async () => {
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
    runPostCorePluginConvergenceSpy.mockImplementationOnce(async ({ cfg }) => ({
      ...postCoreConvergenceResult(),
      installRecords: records,
      config: cfg,
    }));

    await runPostCoreCommand({ yes: true, restart: false });

    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(getLogOutput()).toContain("Plugin updates: 1 updated, 0 unchanged.");
    expect(getLogOutput()).not.toContain("1 skipped");
  });

  it.each([
    {
      name: "does not restore stale backup channels when current pre-update snapshot has none",
      prepare: async (configPath: string, preUpdateConfig: OpenClawConfig) => {
        const updateStartedAtMs = Date.now();
        await writeJsonFixture(`${configPath}.pre-update`, stableConfig());
        await writeJsonFixture(`${configPath}.bak`, preUpdateConfig);
        return { OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(updateStartedAtMs) };
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
        return { OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(Date.now() - 8 * 60 * 60 * 1000) };
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
});
