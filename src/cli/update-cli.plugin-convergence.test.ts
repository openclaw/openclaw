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
import * as assert from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import {
  mockPostCoreConvergenceOnce,
  pluginSyncResult,
  stableConfig,
} from "./update-cli/update-cli-config.test-support.js";
import {
  mockUnbuiltRecoveryFixture,
  recoveryObservationStep,
  recoveryCleanupStep,
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

  async function updatePlugins() {
    const { updatePluginsAfterCoreUpdate } = await import("./update-cli/update-command-plugins.js");
    return updatePluginsAfterCoreUpdate({
      root: process.cwd(),
      channel: "stable",
      configSnapshot: baseSnapshot,
      configWriteOptions: {},
      timeoutMs: 60_000,
    });
  }
  const notice = (message: string, guidance: string[] = []) => ({
    reason: message,
    message,
    guidance,
  });

  it("clears a retry notice when post-core repair succeeds", async () => {
    const failure = { pluginId: "demo", status: "error" as const, message: "Registry unavailable" };
    mockNpmPluginOutcomes([failure]);
    mockPostCoreConvergenceOnce(update.runPostCorePluginConvergenceSpy, {
      changes: ['Repaired plugin "demo".'],
      repairedPluginIds: ["demo"],
      installRecords: {
        demo: { source: "npm", spec: "@example/demo", installPath: "/p/demo", version: "1.0.1" },
      },
    });
    const result = await updatePlugins();
    expect(result).toMatchObject({ status: "ok", warnings: [] });
    expect(result.npm.outcomes).toContainEqual(failure);
    expect(result.npm.outcomes.at(-1)).toMatchObject({
      pluginId: "demo",
      status: "updated",
      nextVersion: "1.0.1",
    });
    expect(assert.getLogOutput()).not.toContain("to retry");
    expect(assert.getLogOutput()).toContain("1 updated, 0 unchanged");
  });

  it("post-core resume children leave run ownership with the parent", async () => {
    const resultDir = createCaseDir("openclaw-post-core-result");
    const resultPath = path.join(resultDir, "plugins.json");
    await fs.mkdir(resultDir, { recursive: true });
    const parentRun = update.createUpdateRun({
      trigger: "cli",
      before: { version: "2026.9.1" },
      target: { version: "2026.9.2" },
    });
    const runsBefore = update.listUpdateRuns();

    await runPostCoreCommand(
      { restart: false },
      {
        OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath,
        OPENCLAW_UPDATE_RUN_ID: parentRun.runId,
      },
    );

    expect(JSON.parse(await fs.readFile(resultPath, "utf-8"))).toMatchObject({ status: "ok" });
    expect(update.defaultRuntime.exit).toHaveBeenCalledWith(0);
    assert.expectNoSideEffects(update.updateGitCheckout, mocks.spawn);
    const runsAfter = update.listUpdateRuns();
    expect(runsAfter).toHaveLength(runsBefore.length);
    const { steps: priorSteps, updatedAtMs: _priorUpdate, ...priorOwnership } = runsBefore[0]!;
    const { steps, updatedAtMs: _updated, ...ownership } = runsAfter[0]!;
    expect(ownership).toEqual(priorOwnership);
    expect(steps).toEqual([
      ...priorSteps,
      expect.objectContaining({ step: "post-plugin doctor", status: "completed", exitCode: 0 }),
    ]);
  });

  it("post-core resume mode persists the requested update channel with the updated process", async () => {
    assert.mockMutableConfigSnapshot(
      configSnapshot({ update: { channel: "stable" } }, { hash: "stable-hash" }),
    );

    await runPostCoreCommand(
      { restart: false },
      {
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "dev",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "dev",
      },
    );

    expect(update.updateGitCheckout).not.toHaveBeenCalled();
    expect(update.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: { update: { channel: "dev" } },
      baseHash: "stable-hash",
    });
    expect(assert.syncPluginCall()).toMatchObject({
      channel: "dev",
      config: { update: { channel: "dev" } },
    });
  });

  it("completes finalize with a plugin retry notice when bridge awaits capability consent", async () => {
    const pluginId = "consent-fixture";
    const config = stableConfig({ plugins: { entries: { [pluginId]: { enabled: true } } } });
    vi.mocked(update.readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
    mockOwnedGitService();
    update.mockGitUpdateAfterMutation(update.makeOkUpdateResult({ root: process.cwd() }));
    mocks.serviceLoaded.mockResolvedValue(true);

    const install = await import("../plugins/install.js");
    vi.spyOn(install, "installPluginFromNpmSpec").mockRejectedValueOnce(
      new ManagedPluginLifecycleError("Operator review token changed.", {
        capabilityConsent: { pluginId, reviewToken: "operator-review" },
      }),
    );
    const actual = await vi.importActual<typeof import("../plugins/update-channel.js")>(
      "../plugins/update-channel.js",
    );
    mocks.syncPluginsForUpdateChannel.mockImplementationOnce((params) =>
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
    vi.mocked(update.resolveOpenClawPackageRoot).mockResolvedValue(root);
    mockOwnedGitService(root);
    mockGatewayHealth("1.0.0", "consent-gateway", "fixture-original-build");
    vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      FRESH_POST_UPDATE_ENTRYPOINT,
    );

    await update.updateFinalizeCommand({ yes: true, json: true });

    update.expectPluginCapabilityRetryNotice(assert.lastWriteJsonCall(), {
      mode: "finalize",
      source: "bridge",
      pluginId,
    });
    expect(update.defaultRuntime.exit).not.toHaveBeenCalledWith(1);

    expect(mocks.serviceStop).toHaveBeenCalledOnce();
    expect(mocks.serviceRestart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ preserveDefinition: true }),
    );
    assert.expectNoSideEffects(update.runDaemonRestart);
    expect(assert.freshRestartCalls()).toHaveLength(0);

    expect(update.runUpdateFailureTriage).not.toHaveBeenCalled();
  });

  it("keeps json update output successful when post-core plugin updates warn", async () => {
    const drift = {
      pluginId: "demo",
      spec: "@openclaw/demo@1.0.0",
      resolvedSpec: "@openclaw/demo@1.0.0",
      resolvedVersion: "1.0.0",
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    };
    mocks.updateNpmInstalledPlugins.mockImplementationOnce(
      async (
        params: Parameters<typeof import("../plugins/update.js").updateNpmInstalledPlugins>[0],
      ) => {
        const proceed = await params.onIntegrityDrift?.({ ...drift, dryRun: false });
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
    vi.mocked(update.defaultRuntime.writeJson).mockClear();

    await update.updateCommand({ json: true, restart: false });

    const jsonOutput = assert.lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(update.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    const plugins = jsonOutput?.postUpdate?.plugins;
    expect(plugins?.integrityDrifts).toEqual([{ ...drift, action: "aborted" }]);
    expect(plugins?.status).toBe("warning");
    expect(plugins?.npm.outcomes[0]).toMatchObject({
      status: "error",
      message: expect.stringContaining("npm package integrity drift"),
    });
    expect(assert.pluginWarning(jsonOutput)).toMatchObject({
      pluginId: "demo",
      guidance: ["openclaw plugins update demo"],
      reason: expect.stringContaining("npm package integrity drift"),
    });
  });

  it.each(["sync", "update"] as const)(
    "prints ClawHub %s trust warnings once in human output",
    async (source) => {
      const trustWarning = clawHubSuspiciousPayloadWarning;
      if (source === "sync") {
        mocks.syncPluginsForUpdateChannel.mockImplementationOnce(
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
        mocks.updateNpmInstalledPlugins.mockImplementationOnce(
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
      await update.updateCommand({ yes: true, restart: false });
      const output = assert.getLogOutput();
      expect(output.split(trustWarning).length - 1).toBe(1);
      if (source === "sync") {
        expect(
          vi.mocked(update.defaultRuntime.log).mock.calls.filter(([line]) => line === trustWarning),
        ).toHaveLength(1);
      } else {
        expect(output).toContain("openclaw plugins update demo");
      }
    },
  );

  it.each([
    { json: false, repaired: false },
    { json: true, repaired: true },
  ])(
    "reports unavailable retained plugin targets without failing core ($json, repaired=$repaired)",
    async ({ json, repaired }) => {
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
        version: "1.0.0",
      };
      const records = { demo: record };
      const warningLogPath = path.join(installPath, "update-warning.log");
      setLoggerOverride({ level: "warn", file: warningLogPath });
      onTestFinished(async () => {
        await flushLogger();
        resetLogger();
      });
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
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
      mockPostCoreConvergenceOnce(update.runPostCorePluginConvergenceSpy, {
        installRecords: repaired ? { demo: { ...record, version: "2.0.0" } } : records,
      });

      await update.updateCommand({ yes: true, json, restart: false });

      expect(update.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
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
        expect(assert.lastWriteJsonCall()).toMatchObject({
          status: "ok",
          postUpdate: { plugins: { warnings: [] } },
        });
      } else {
        expect(stripAnsi(assert.getLogOutput())).toContain(message);
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
        update.mockGitUpdateAfterMutation();
        vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
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
      vi.mocked(update.defaultRuntime.writeJson).mockClear();

      await update.updateCommand({ json: true, restart: false });

      const result = assert.lastWriteJsonCall() as UpdateRunResult | undefined;
      expect(result?.postUpdate?.plugins?.status).toBe("warning");
      expect(assert.pluginWarning(result)).toMatchObject({
        pluginId: "demo",
        guidance: ["openclaw plugins update demo"],
      });
      expect(assert.pluginOutcome(result)).toMatchObject({ pluginId: "demo", status: "skipped" });
      if (blocked) {
        expect(assert.pluginWarning(result)?.reason).toContain("Security scan: malicious");
        expect(assert.pluginWarning(result)?.reason).toContain("ClawHub blocked this release");
        expect(assert.pluginOutcome(result)?.message).toContain(
          "Existing installed plugin left unchanged",
        );
      }
    },
  );

  it("fails unexpected post-core npm update exceptions", async () => {
    await mockUnbuiltRecoveryFixture();
    const message = "npm update invariant broke";
    mocks.updateNpmInstalledPlugins.mockRejectedValueOnce(new Error(message));

    await expect(update.updateCommand({ json: true, restart: false })).rejects.toEqual(
      new update.ExitError(1),
    );
    expect(update.defaultRuntime.exit).not.toHaveBeenCalled();
    const result = assert.lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(result?.verification).toEqual({});
    expect(result).toMatchObject({
      status: "error",
      reason: "post-update-failed",
      steps: [
        expect.objectContaining({ exitCode: 1, stderrTail: message }),
        recoveryObservationStep(),
        recoveryCleanupStep(),
      ],
    });
  });
  it("preserves convergence diagnostic output", async () => {
    const repairWarning = notice("Package lookup deferred.", ["Retry plugin repair."]);
    const smokeWarning = {
      pluginId: "reporting-fixture",
      reason: "missing-main-entry: entry missing",
      message: 'Plugin "reporting-fixture" failed payload verification.',
      guidance: ["Inspect the plugin entry."],
    };
    const retainedNotice = notice("Retained plugin remains available.");
    const warnings = [repairWarning, { ...smokeWarning, kind: "load" as const }];
    mockPostCoreConvergenceOnce(update.runPostCorePluginConvergenceSpy, {
      warnings,
      errored: true,
      notices: [retainedNotice],
    });
    const result = await updatePlugins();

    expect(result.status).toBe("warning");
    expect(result.warnings).toEqual([
      expect.objectContaining({
        reason: repairWarning.reason,
        guidance: ["openclaw update repair"],
      }),
      expect.objectContaining({
        pluginId: smokeWarning.pluginId,
        reason: smokeWarning.reason,
        guidance: ["openclaw doctor --fix"],
      }),
      retainedNotice,
    ]);
    expect(result.npm.outcomes).toEqual([
      { pluginId: smokeWarning.pluginId, status: "error", message: smokeWarning.message },
    ]);
    for (const message of [
      "openclaw update repair",
      "openclaw doctor --fix",
      retainedNotice.message,
    ]) {
      expect(stripAnsi(assert.getLogOutput())).toContain(message);
    }
  });
});
