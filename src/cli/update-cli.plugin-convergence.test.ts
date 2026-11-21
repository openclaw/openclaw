import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import { VERSION } from "../version.js";
import * as assert from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import {
  mockPostCoreConvergenceOnce,
  stableConfig,
} from "./update-cli/update-cli-config.test-support.js";
import {
  mockUnbuiltRecoveryFixture,
  recoveryObservationStep,
  recoveryCleanupStep,
} from "./update-cli/update-cli-failure-recovery.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseSnapshot,
    configSnapshot,
    createCaseDir,
    FRESH_POST_UPDATE_ENTRYPOINT,
    mockGatewayHealth,
    mockNpmPluginOutcomes,
    mockOwnedGitService,
    mockPackageInstallAtCaseDir,
    primeNpmChannelTag,
    runPostCoreCommand,
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
    const { recordUpdateRunStep } = await import("../infra/update-run-ledger.js");
    recordUpdateRunStep(parentRun.runId, { step: "openclaw doctor", status: "completed" });
    recordUpdateRunStep(parentRun.runId, {
      step: "post-update verification",
      status: "in_progress",
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
    assert.expectNoSideEffects(update.updateGitRelease, mocks.spawn);
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

    expect(update.updateGitRelease).not.toHaveBeenCalled();
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

  it("fails unexpected post-core npm update exceptions", async () => {
    await mockUnbuiltRecoveryFixture();
    process.chdir(await mockPackageInstallAtCaseDir("openclaw-current-plugin-exception", VERSION));
    mocks.readPackageVersion.mockResolvedValue(VERSION);
    primeNpmChannelTag("latest", VERSION);
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
