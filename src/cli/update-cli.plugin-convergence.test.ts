import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub-error-codes.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  getLogOutput,
  lastWriteJsonCall,
  mockMutableConfigSnapshot,
  syncPluginCall,
  pluginOutcome,
  pluginWarning,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  loadInstalledPluginIndexInstallRecords,
  runtimeCapture,
  serviceLoaded,
  serviceRestart,
  serviceStop,
  spawn,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  createUpdateRun,
  defaultRuntime,
  expectPluginCapabilityRetryNotice,
  listUpdateRuns,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  mutateConfigFileWithRetry,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveOpenClawPackageRoot,
  runDaemonRestart,
  runPostCorePluginConvergenceSpy,
  runUpdateFailureTriage,
  updateCommand,
  updateFinalizeCommand,
  updateGitCheckout,
  ExitError,
} from "./update-cli-modules.test-support.js";
import {
  mockPostCoreConvergenceOnce,
  pluginSyncResult,
  stableConfig,
} from "./update-cli/update-cli-config.test-support.js";
import {
  mockUnbuiltRecoveryFixture,
  recoveryVerificationStep,
  recoveryVersionMismatch,
} from "./update-cli/update-cli-failure-recovery.test-support.js";
import {
  writeJsonFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    baseSnapshot,
    configSnapshot,
    createCaseDir,
    FRESH_POST_UPDATE_ENTRYPOINT,
    mockGatewayHealth,
    mockNpmPluginOutcomes,
    mockOwnedGitService,
    runPostCoreCommand,
    clawHubSuspiciousPayloadWarning,
    clawHubSyncRiskError,
  } = createUpdateCliFixture();

  it("clears a retry notice when post-core repair succeeds", async () => {
    const failure = { pluginId: "demo", status: "error" as const, message: "Registry unavailable" };
    mockNpmPluginOutcomes([failure]);
    mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
      changes: ['Repaired plugin "demo".'],
      repairedPluginIds: ["demo"],
      installRecords: {
        demo: { source: "npm", spec: "@example/demo", installPath: "/p/demo", version: "1.0.1" },
      },
    });
    const { updatePluginsAfterCoreUpdate } = await import("./update-cli/update-command-plugins.js");

    const result = await updatePluginsAfterCoreUpdate({
      root: process.cwd(),
      channel: "stable",
      configSnapshot: baseSnapshot,
      configWriteOptions: {},
      timeoutMs: 60_000,
    });

    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
    expect(result.npm.outcomes).toContainEqual(failure);
    expect(result.npm.outcomes.at(-1)).toMatchObject({
      pluginId: "demo",
      status: "updated",
      nextVersion: "1.0.1",
    });
    expect(getLogOutput()).not.toContain("to retry");
    expect(getLogOutput()).toContain("1 updated, 0 unchanged");
  });

  it("post-core resume children leave run ownership with the parent", async () => {
    const resultDir = createCaseDir("openclaw-post-core-result");
    const resultPath = path.join(resultDir, "plugins.json");
    await fs.mkdir(resultDir, { recursive: true });
    const parentRun = createUpdateRun({
      trigger: "cli",
      before: { version: "2026.9.1" },
      target: { version: "2026.9.2" },
    });
    const runsBefore = listUpdateRuns();

    await runPostCoreCommand(
      { restart: false },
      {
        OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath,
        OPENCLAW_UPDATE_RUN_ID: parentRun.runId,
      },
    );

    const result = JSON.parse(await fs.readFile(resultPath, "utf-8")) as {
      status?: string;
    };
    expect(result.status).toBe("ok");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
    expectNoSideEffects(updateGitCheckout, spawn);
    expect(listUpdateRuns()).toEqual(runsBefore);
  });

  it("post-core resume mode prefers post-doctor disk install records over the stale parent snapshot", async () => {
    const resultDir = createCaseDir("openclaw-post-core-disk-records");
    const recordsPath = path.join(resultDir, "plugin-install-records.json");
    await fs.mkdir(resultDir, { recursive: true });
    await writeJsonFixture(recordsPath, {
      stale: {
        source: "npm",
        spec: "@openclaw/stale@1.0.0",
        installPath: "/tmp/stale-plugin",
      },
    });
    const postDoctorRecords = {
      codex: {
        source: "npm",
        spec: "@openclaw/codex@2026.5.17",
        installPath: "/tmp/codex-plugin",
      },
    } satisfies Record<string, PluginInstallRecord>;
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(postDoctorRecords);

    await runPostCoreCommand(
      { json: true, restart: false },
      { OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: recordsPath },
    );

    expect(syncPluginCall()?.config?.plugins?.installs).toEqual(postDoctorRecords);
  });

  it("post-core resume mode persists the requested update channel with the updated process", async () => {
    mockMutableConfigSnapshot(
      configSnapshot({ update: { channel: "stable" } }, { hash: "stable-hash" }),
    );

    await runPostCoreCommand(
      { restart: false },
      {
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "dev",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "dev",
      },
    );

    expect(updateGitCheckout).not.toHaveBeenCalled();
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: { update: { channel: "dev" } },
      baseHash: "stable-hash",
    });
    expect(mutateConfigFileWithRetry).toHaveBeenCalledExactlyOnceWith({
      mutate: expect.any(Function),
      writeOptions: {
        assertCurrent: expect.any(Function),
        beforeCommit: expect.any(Function),
        observe: false,
        skipPluginValidation: true,
      },
    });
    expect(syncPluginCall()?.channel).toBe("dev");
    expect(syncPluginCall()?.config?.update?.channel).toBe("dev");
  });

  it("prints plugin channel fallbacks near the post-core plugin summary", async () => {
    mockNpmPluginOutcomes([
      {
        pluginId: "lossless-claw",
        status: "updated",
        message: "Updated lossless-claw: 1.0.0 -> 1.0.1.",
        channelFallback: {
          requestedSpec: "lossless-claw@beta",
          usedSpec: "lossless-claw",
          requestedLabel: "@beta",
          usedLabel: "@latest",
          reason: "unavailable",
          message:
            "plugin channel fallback: lossless-claw used @latest because @beta was unavailable",
        },
      },
    ]);

    await runPostCoreCommand({ restart: false }, { OPENCLAW_UPDATE_POST_CORE_CHANNEL: "beta" });

    const logs = vi.mocked(runtimeCapture.log).mock.calls.map((call) => String(call[0]));
    expect(logs.some((line) => line.includes("Plugin updates: 1 updated, 0 unchanged."))).toBe(
      true,
    );
    expect(
      logs.some((line) =>
        line.includes(
          "plugin channel fallback: lossless-claw used @latest because @beta was unavailable",
        ),
      ),
    ).toBe(true);
  });

  it.each([{ source: "bridge", mode: "finalize" }] as const)(
    "completes $mode with a plugin retry notice when $source awaits capability consent",
    async ({ source, mode }) => {
      const pluginId = "consent-fixture";
      const config = stableConfig({ plugins: { entries: { [pluginId]: { enabled: true } } } });
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
      mockOwnedGitService();
      mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));
      serviceLoaded.mockResolvedValue(true);

      const install = await import("../plugins/install.js");
      vi.spyOn(install, "installPluginFromNpmSpec").mockRejectedValueOnce(
        new ManagedPluginLifecycleError("Operator review token changed.", {
          capabilityConsent: { pluginId, reviewToken: "operator-review" },
        }),
      );
      const actual = await vi.importActual<typeof import("../plugins/update-channel.js")>(
        "../plugins/update-channel.js",
      );
      syncPluginsForUpdateChannel.mockImplementationOnce((params) =>
        actual.syncPluginsForUpdateChannel({
          ...params,
          externalizedBundledPluginBridges: [
            { bundledPluginId: pluginId, npmSpec: "@example/companion" },
          ],
        }),
      );

      const root = createCaseDir("consent-finalize");
      await writeOpenClawPackageFixture(root, "1.0.0", {
        git: true,
        builtSha: "a".repeat(40),
        entrySource: "export {};\n",
      });
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
      mockOwnedGitService(root);
      mockGatewayHealth("1.0.0", "consent-gateway", "fixture-original-build");
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
        FRESH_POST_UPDATE_ENTRYPOINT,
      );

      const command = updateFinalizeCommand({ yes: true, json: true });
      await command;

      expectPluginCapabilityRetryNotice(lastWriteJsonCall(), { mode, source, pluginId });
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);

      expect(serviceStop).toHaveBeenCalledOnce();
      expect(serviceRestart).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ preserveDefinition: true }),
      );
      expectNoSideEffects(runDaemonRestart);
      expect(freshRestartCalls()).toHaveLength(0);

      expect(runUpdateFailureTriage).not.toHaveBeenCalled();
    },
  );

  it("keeps json update output successful when post-core plugin updates warn", async () => {
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        config: OpenClawConfig;
        onIntegrityDrift?: (drift: {
          pluginId: string;
          spec: string;
          resolvedSpec?: string;
          resolvedVersion?: string;
          expectedIntegrity: string;
          actualIntegrity: string;
          dryRun: boolean;
        }) => Promise<boolean>;
      }) => {
        const proceed = await params.onIntegrityDrift?.({
          pluginId: "demo",
          spec: "@openclaw/demo@1.0.0",
          resolvedSpec: "@openclaw/demo@1.0.0",
          resolvedVersion: "1.0.0",
          expectedIntegrity: "sha512-old",
          actualIntegrity: "sha512-new",
          dryRun: false,
        });
        return {
          changed: false,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "error",
              message:
                proceed === false
                  ? "Failed to update demo: aborted: npm package integrity drift detected for @openclaw/demo@1.0.0"
                  : "unexpected drift continuation",
            },
          ],
        };
      },
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    expect(jsonOutput?.postUpdate?.plugins?.integrityDrifts).toEqual([
      {
        pluginId: "demo",
        spec: "@openclaw/demo@1.0.0",
        resolvedSpec: "@openclaw/demo@1.0.0",
        resolvedVersion: "1.0.0",
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
        action: "aborted",
      },
    ]);
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.guidance).toEqual(["openclaw plugins update demo"]);
    expect(pluginWarning(jsonOutput)?.reason).toContain("npm package integrity drift");
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.status).toBe("error");
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain(
      "npm package integrity drift",
    );
  });

  it.each(["sync", "update"] as const)(
    "prints ClawHub %s trust warnings once in human output",
    async (source) => {
      const trustWarning = clawHubSuspiciousPayloadWarning;
      if (source === "sync") {
        syncPluginsForUpdateChannel.mockImplementationOnce(
          async (params: {
            config: OpenClawConfig;
            logger?: { warn?: (message: string) => void };
          }) => {
            params.logger?.warn?.(trustWarning);
            return pluginSyncResult(params.config, false, {
              warnings: [trustWarning],
              errors: [{ pluginId: "demo", message: clawHubSyncRiskError }],
            });
          },
        );
      } else {
        updateNpmInstalledPlugins.mockImplementationOnce(
          async (params: {
            config: OpenClawConfig;
            logger?: { warn?: (message: string) => void };
          }) => {
            params.logger?.warn?.(trustWarning);
            return {
              changed: false,
              config: params.config,
              outcomes: [
                {
                  pluginId: "demo",
                  status: "skipped",
                  code: CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED,
                  warning: trustWarning,
                  message:
                    "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged.",
                },
              ],
            };
          },
        );
      }
      await updateCommand({ yes: true, restart: false });
      const output = getLogOutput();
      expect(output.split(trustWarning).length - 1).toBe(1);
      if (source === "sync") {
        expect(
          vi.mocked(defaultRuntime.log).mock.calls.filter(([line]) => line === trustWarning),
        ).toHaveLength(1);
      } else {
        expect(output).toContain("openclaw plugins update demo");
      }
    },
  );

  it.each([
    { json: false, repaired: false, version: "1.0.0" },
    { json: true, repaired: true, version: "1.0.0" },
  ])(
    "reports unavailable retained plugin targets without failing core ($json, repaired=$repaired, version=$version)",
    async ({ json, repaired, version }) => {
      const message =
        'Retained plugin "demo" at 1.0.0: requested @example/demo@2.0.0 for core 9999.0.0 could not be resolved: No matching version found. Run `openclaw plugins update demo` when the package or registry is available.';
      const installPath = createCaseDir("unavailable-target");
      await fs.mkdir(installPath, { recursive: true });
      await writeJsonFixture(path.join(installPath, "package.json"), {
        name: "@example/demo",
        version: "1.0.0",
      });
      const record: PluginInstallRecord = {
        source: "npm",
        spec: "@example/demo@2.0.0",
        installPath,
        version,
      };
      const records = { demo: record };
      const warningLogPath = path.join(installPath, "update-warning.log");
      setLoggerOverride({ level: "warn", file: warningLogPath });
      onTestFinished(async () => {
        await flushLogger();
        resetLogger();
      });
      loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mockNpmPluginOutcomes(
        [
          {
            pluginId: "demo",
            status: "unchanged",
            code: "plugin-target-unavailable",
            currentVersion: "1.0.0",
            message,
          },
        ],
        false,
        { ...baseConfig, plugins: { ...baseConfig.plugins, installs: records } },
      );
      mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
        installRecords: repaired ? { demo: { ...record, version: "2.0.0" } } : records,
      });

      await updateCommand({ yes: true, json, restart: false });

      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      await flushLogger();
      const logEntries = fsSync.existsSync(warningLogPath)
        ? (await fs.readFile(warningLogPath, "utf8"))
            .trim()
            .split("\n")
            .map((line): unknown => JSON.parse(line))
        : [];
      const retainedWarning = expect.objectContaining({
        message,
        _meta: expect.objectContaining({ logLevelName: "WARN" }),
      });
      if (repaired) {
        expect(logEntries).not.toContainEqual(retainedWarning);
      } else {
        expect(logEntries).toContainEqual(retainedWarning);
      }
      if (json) {
        const result = lastWriteJsonCall();
        if (repaired) {
          expect(result).toMatchObject({ status: "ok", postUpdate: { plugins: { warnings: [] } } });
          return;
        }
        expect(result).toMatchObject({
          status: "ok",
          postUpdate: {
            plugins: {
              status: "warning",
              warnings: [
                expect.objectContaining({
                  pluginId: "demo",
                  reason: "plugin-target-unavailable",
                  message,
                }),
              ],
            },
          },
          run: {
            status: "succeeded",
            steps: expect.arrayContaining([
              expect.objectContaining({
                step: expect.stringMatching(/^warning:/),
                status: "completed",
                detail: expect.stringContaining(message),
              }),
            ]),
          },
        });
        expect(result).not.toHaveProperty("reason", "plugin-target-unavailable");
      } else {
        expect(stripAnsi(getLogOutput())).toContain(message);
      }
    },
  );

  it.each(["disabled after failure", "ClawHub blocked"] as const)(
    "reports actionable skipped plugin updates: %s",
    async (kind) => {
      const blocked = kind === "ClawHub blocked";
      const trustWarning =
        "╭─ BLOCKED - ClawHub flagged this release as malicious ─╮\n" +
        "│ • Security scan: malicious                           │\n" +
        "╰──────────────────────────────────────────────────────╯";
      if (!blocked) {
        mockGitUpdateAfterMutation();
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
          "/tmp/openclaw-updated-entry.mjs",
        );
      }
      mockNpmPluginOutcomes(
        [
          {
            pluginId: "demo",
            status: "skipped",
            ...(blocked ? { code: "clawhub_download_blocked", warning: trustWarning } : {}),
            message: blocked
              ? "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged."
              : 'Disabled "demo" after plugin update failure; OpenClaw will continue without it. Failed to update demo: registry timeout',
          },
        ],
        !blocked,
      );
      vi.mocked(defaultRuntime.writeJson).mockClear();

      await updateCommand({ json: true, restart: false });

      const result = lastWriteJsonCall() as UpdateRunResult | undefined;
      expect(result?.postUpdate?.plugins?.status).toBe("warning");
      expect(pluginWarning(result)?.pluginId).toBe("demo");
      expect(pluginWarning(result)?.guidance).toEqual(["openclaw plugins update demo"]);
      expect(pluginOutcome(result)?.pluginId).toBe("demo");
      expect(pluginOutcome(result)?.status).toBe("skipped");
      if (blocked) {
        expect(pluginWarning(result)?.reason).toContain("Security scan: malicious");
        expect(pluginWarning(result)?.reason).toContain("ClawHub blocked this release");
        expect(pluginOutcome(result)?.message).toContain(
          "Existing installed plugin left unchanged",
        );
      }
    },
  );

  it.each([["npm update", updateNpmInstalledPlugins]] as const)(
    "fails unexpected post-core %s exceptions",
    async (phase, updatePlugins) => {
      await mockUnbuiltRecoveryFixture();
      const message = `${phase} invariant broke`;
      updatePlugins.mockRejectedValueOnce(new Error(message));

      await expect(updateCommand({ json: true, restart: false })).rejects.toEqual(new ExitError(1));
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "post-update-failed",
        steps: [
          expect.objectContaining({ exitCode: 1, stderrTail: message }),
          recoveryVerificationStep([recoveryVersionMismatch]),
        ],
      });
    },
  );
  it("preserves convergence diagnostic output", async () => {
    const repairWarning = {
      reason: "Package lookup deferred.",
      message: "Package lookup deferred.",
      guidance: ["Retry plugin repair."],
    };
    const smokeWarning = {
      pluginId: "reporting-fixture",
      reason: "missing-main-entry: entry missing",
      message: 'Plugin "reporting-fixture" failed payload verification.',
      guidance: ["Inspect the plugin entry."],
    };
    const notice = {
      reason: "Retained plugin remains available.",
      message: "Retained plugin remains available.",
      guidance: [],
    };
    const warnings = [repairWarning, { ...smokeWarning, kind: "load" as const }];
    const reportedRepairWarning = {
      ...repairWarning,
      message: "Plugin updates could not complete. Run `openclaw update repair` to retry.",
      guidance: ["openclaw update repair"],
    };
    const reportedSmokeWarning = {
      ...smokeWarning,
      message:
        'Plugin "reporting-fixture" could not be loaded. Run `openclaw doctor --fix` to check and repair the load problem.',
      guidance: ["openclaw doctor --fix"],
    };
    mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
      warnings,
      errored: true,
      notices: [notice],
    });
    const { updatePluginsAfterCoreUpdate } = await import("./update-cli/update-command-plugins.js");

    const result = await updatePluginsAfterCoreUpdate({
      root: process.cwd(),
      channel: "stable",
      configSnapshot: baseSnapshot,
      configWriteOptions: {},
      timeoutMs: 60_000,
      json: false,
    });

    expect(result).toEqual({
      status: "warning",
      assessment: { kind: "unsafe", reason: "convergence-failed" },
      changed: false,
      warnings: [reportedRepairWarning, reportedSmokeWarning, notice],
      sync: {
        changed: false,
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
      npm: {
        changed: false,
        outcomes: [
          { pluginId: "reporting-fixture", status: "error", message: smokeWarning.message },
        ],
      },
      integrityDrifts: [],
    });
    const logs = vi
      .mocked(defaultRuntime.log)
      .mock.calls.map(([value]) => stripAnsi(String(value)));
    expect(logs).toEqual([
      "",
      "Updating plugins...",
      "Plugin updates: 0 updated, 0 unchanged, 1 to retry.",
      reportedRepairWarning.message,
      reportedSmokeWarning.message,
      notice.message,
    ]);
  });
});
