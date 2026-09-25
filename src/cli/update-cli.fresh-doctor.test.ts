import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import {
  commandCalls,
  expectNoSideEffects,
  getErrorOutput,
  lastWriteJsonCall,
  npmPluginUpdateCall,
  packageInstallCommandCall,
  spawnCall,
  syncPluginCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  callGateway,
  candidateValidation,
  readPackageVersion,
  spawn,
  stateSchemaVersions,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  continuePostCoreUpdateInFreshProcess,
  defaultRuntime,
  doctorChild,
  ExitError,
  expectDelegatedPluginDoctorInput,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveOpenClawPackageRoot,
  resolveUpdateInstallKind,
  runDaemonInstall,
  runExec,
  runPostCorePluginConvergenceSpy,
  runUtf8CommandWithTimeout,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  createConfigValidationFailure,
  mockPostCoreConvergenceOnce,
} from "./update-cli/update-cli-config.test-support.js";
import { registerForegroundFailureRecoveryTests } from "./update-cli/update-cli-failure-recovery.test-support.js";
import { writeGitUpdateResultFixture } from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    baseSnapshot,
    completeChangedPostCorePluginUpdate,
    configSnapshot,
    createCaseDir,
    FRESH_POST_UPDATE_ENTRYPOINT,
    mockCurrentProcessFreshDoctor,
    mockFileBackedPathExists,
    mockNpmPluginOutcomes,
    mockServicePackageCommands,
    primeNpmChannelTag,
    reportCandidateSteps,
    setupInstalledPackageRoot,
    setupUpdatedRootRefresh,
  } = createUpdateCliFixture();

  it("respawns into the updated git root before requested channel persistence", async () => {
    const { entrypoints } = setupUpdatedRootRefresh({
      gatewayUpdateImpl: (root) =>
        writeGitUpdateResultFixture({
          root,
          before: { sha: "old-sha", version: "2026.4.26" },
          after: { sha: "new-sha", version: VERSION },
        }),
    });

    await updateCommand({ channel: "dev", yes: true, restart: false });

    const call = spawnCall();
    expect(call?.[0]).toMatch(/node/);
    expect(call?.[1]).toEqual([
      entrypoints[0],
      "update",
      "--no-restart",
      "--yes",
      "--timeout",
      "1800",
    ]);
    expect(call?.[2]?.stdio).toBe("inherit");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("dev");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("dev");
    expectNoSideEffects(replaceConfigFile, syncPluginsForUpdateChannel, updateNpmInstalledPlugins);
  });

  it("carries explicit capability consent into post-core plugin convergence", async () => {
    const { entrypoints } = setupUpdatedRootRefresh({
      gatewayUpdateImpl: (root) =>
        writeGitUpdateResultFixture({
          root,
          before: { sha: "old-sha", version: "2026.4.26" },
          after: { sha: "new-sha", version: VERSION },
        }),
    });
    vi.mocked(runExec).mockResolvedValueOnce({
      stdout: new Command("update").option("--accept-capabilities").helpInformation(),
      stderr: "",
    });

    await updateCommand({ acceptCapabilities: true, yes: true, restart: false });

    expect(spawnCall()?.[1]).toEqual([
      entrypoints[0],
      "update",
      "--no-restart",
      "--yes",
      "--accept-capabilities",
      "--timeout",
      "1800",
    ]);
  });

  it.each([
    { acceptCapabilities: true, supported: true, resumed: true },
    { acceptCapabilities: true, supported: false, resumed: false },
    { acceptCapabilities: false, supported: false, resumed: true },
  ])(
    "checks target consent support before handoff (explicit=$acceptCapabilities, supported=$supported)",
    async ({ acceptCapabilities, supported, resumed }) => {
      const { root, entrypoints } = setupUpdatedRootRefresh();
      readPackageVersion.mockResolvedValue(VERSION);
      const targetCommand = new Command("update");
      if (supported) {
        targetCommand.option("--accept-capabilities");
      }
      vi.mocked(runExec).mockResolvedValue({ stdout: targetCommand.helpInformation(), stderr: "" });

      const result = await continuePostCoreUpdateInFreshProcess({
        root,
        channel: "stable",
        requestedChannel: null,
        opts: { acceptCapabilities, restart: false },
        pluginInstallRecords: {},
        updateStartedAtMs: Date.now(),
        timeoutMs: 30_000,
      });

      expect(result).toEqual({ resumed });
      if (acceptCapabilities) {
        expect(runExec).toHaveBeenCalledWith(
          expect.any(String),
          [entrypoints[0], "update", "--help"],
          expect.objectContaining({ timeoutMs: 30_000, logOutput: false }),
        );
      } else {
        expect(runExec).not.toHaveBeenCalled();
      }
      if (resumed) {
        expect(spawnCall()?.[1]).toEqual([
          entrypoints[0],
          "update",
          "--no-restart",
          ...(acceptCapabilities ? ["--accept-capabilities"] : []),
          "--timeout",
          "30",
        ]);
      } else {
        expect(spawn).not.toHaveBeenCalled();
      }
    },
  );

  it("does not treat failed target consent help as an unsupported option", async () => {
    const { root } = setupUpdatedRootRefresh();
    const failure = new Error("target help failed");
    vi.mocked(runExec).mockRejectedValueOnce(failure);

    await expect(
      continuePostCoreUpdateInFreshProcess({
        root,
        channel: "stable",
        requestedChannel: null,
        opts: { acceptCapabilities: true },
        pluginInstallRecords: {},
        updateStartedAtMs: Date.now(),
        timeoutMs: 30_000,
      }),
    ).rejects.toBe(failure);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { targetVersion: "2026.4.10", fresh: false },
    { targetVersion: "2026.4.29", fresh: true },
    { targetVersion: "2026.9.1", fresh: true },
  ])(
    "finalizes downgrade to $targetVersion with target writer=$fresh",
    async ({ targetVersion, fresh }) => {
      const runWorker = expectDefined(
        vi.mocked(runUtf8CommandWithTimeout).getMockImplementation(),
        "worker transport is initialized",
      );
      vi.mocked(runUtf8CommandWithTimeout).mockImplementation((argv, options) => {
        if (argv.includes("--check")) {
          return Promise.reject(
            new Error("Older target does not contain the migration-continuation worker"),
          );
        }
        return runWorker(argv, options);
      });
      candidateValidation.mockImplementation(async (options) =>
        reportCandidateSteps(options, {
          status: "ok",
          steps: [
            {
              name: "candidate-recovery",
              command: "--check",
              cwd: options.root,
              durationMs: 0,
              exitCode: null,
              advisory: {
                kind: "candidate-runtime-unavailable",
                message:
                  "candidate predates the migration-continuation contract; finalization runs in the current binary",
              },
            },
          ],
        }),
      );
      const inspectOriginalState = expectDefined(
        stateSchemaVersions.getMockImplementation(),
        "state schema inspection mock is initialized",
      );
      stateSchemaVersions.mockImplementation(async (options) => {
        if (options.root !== undefined) {
          throw new Error("The older target has no state schema worker");
        }
        return inspectOriginalState(options);
      });
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
        createCaseDir("openclaw-downgrade-writer"),
        "2026.9.3-beta.1",
      );
      mockFileBackedPathExists();
      readPackageVersion.mockImplementation(async (root: string) => {
        const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        return pkg.version;
      });
      mockServicePackageCommands({
        nodeModules,
        packageRoot: pkgRoot,
        targetVersion,
        npmCommands: ["npm"],
        nodeVersions: {},
      });
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entryPath);

      await updateCommand({ channel: "stable", yes: true, tag: targetVersion, restart: false });

      if (fresh) {
        expect(spawn).toHaveBeenCalledOnce();
        expect(spawnCall()?.[1]).toContain(entryPath);
        expect(spawnCall()?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("stable");
        expectNoSideEffects(
          replaceConfigFile,
          syncPluginsForUpdateChannel,
          updateNpmInstalledPlugins,
        );
      } else {
        expect(spawn).not.toHaveBeenCalled();
        expect(syncPluginsForUpdateChannel).toHaveBeenCalledOnce();
        expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      }
      expectNoSideEffects(runDaemonInstall, callGateway);
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    },
  );

  it.each([true, false])(
    "checks original Git version before a package downgrade (dry-run=%s)",
    async (dryRun) => {
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(
        createCaseDir("openclaw-git-downgrade"),
      );
      readPackageVersion.mockResolvedValue("2026.9.3-beta.1");
      primeNpmChannelTag("latest", "2026.9.1");

      await updateCommand({ channel: "stable", json: true, dryRun });

      if (dryRun) {
        expect(lastWriteJsonCall()).toMatchObject({
          currentVersion: "2026.9.3-beta.1",
          targetVersion: "2026.9.1",
          downgradeRisk: true,
          switchToPackage: true,
        });
      } else {
        expect(getErrorOutput()).toContain("Downgrade confirmation required.");
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      }
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expectNoSideEffects(updateGitCheckout, replaceConfigFile, spawn);
    },
  );

  it.each([false, true])(
    "keeps downgrade consent separate from --yes (explicit=%s)",
    async (acceptCapabilities) => {
      const downgradedRoot = createCaseDir("openclaw-downgraded-consent-root");
      vi.mocked(resolveUpdateInstallKind).mockImplementation(async (root) =>
        root === downgradedRoot ? "package" : "git",
      );
      setupUpdatedRootRefresh({
        targetVersion: "2026.4.10",
        gatewayUpdateImpl: async () =>
          makeOkUpdateResult({
            mode: "npm",
            root: downgradedRoot,
            before: { version: "2026.4.14" },
            after: { version: "2026.4.10" },
          }),
      });
      readPackageVersion.mockImplementation(async (pkgRoot: string) =>
        pkgRoot === downgradedRoot ? "2026.4.10" : "2026.4.14",
      );
      primeNpmChannelTag("latest", "2026.4.10");
      mockCurrentProcessFreshDoctor({ postCoreResumeAttempt: false });

      await updateCommand({
        acceptCapabilities,
        yes: true,
        tag: "2026.4.10",
        restart: false,
      });

      const handler = npmPluginUpdateCall()?.onCapabilityConsent as
        | ((review: { reviewToken: string }) => Promise<{ reviewToken: string }>)
        | undefined;
      if (acceptCapabilities) {
        await expect(handler?.({ reviewToken: "reviewed-surface" })).resolves.toEqual({
          reviewToken: "reviewed-surface",
        });
      } else {
        expect(handler).toBeUndefined();
      }
      expect(syncPluginCall()?.onCapabilityConsent).toBe(handler);
    },
  );

  it("pins the compatibility host version to the downgraded target during current-process post-core plugin convergence (#87914)", async () => {
    const downgradedRoot = createCaseDir("openclaw-downgraded-compat-root");
    vi.mocked(resolveUpdateInstallKind).mockImplementation(async (root) =>
      root === downgradedRoot ? "package" : "git",
    );
    setupUpdatedRootRefresh({
      targetVersion: "2026.4.10",
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: downgradedRoot,
          before: { version: "2026.4.14" },
          after: { version: "2026.4.10" },
        }),
    });
    // The old core is still installed at the invocation root; the freshly
    // installed downgraded target lives at the post-update root.
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === downgradedRoot ? "2026.4.10" : "2026.4.14",
    );
    primeNpmChannelTag("latest", "2026.4.10");

    delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    mockCurrentProcessFreshDoctor({ postCoreResumeAttempt: false });
    let hostVersionDuringPluginUpdate: string | undefined = "unset";
    updateNpmInstalledPlugins.mockImplementation(async () => {
      hostVersionDuringPluginUpdate = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
      return { changed: false, config: baseConfig, outcomes: [] };
    });

    try {
      await updateCommand({ yes: true, tag: "2026.4.10", restart: false });

      expect(spawn).not.toHaveBeenCalled();
      expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
      // Compatibility is evaluated against the downgraded target core, not the
      // still-running old VERSION, so incompatible newer plugins are disabled
      // before restart.
      expect(hostVersionDuringPluginUpdate).toBe("2026.4.10");
      expect(runPostCorePluginConvergenceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ compatibilityHostVersion: "2026.4.10" }),
      );
      // The override is scoped to the plugin convergence and restored afterward.
      expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
    } finally {
      delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    }
  });

  it("runs updated plugin migrations for a plugin-only current-process update", async () => {
    // This path exercises delegated Doctor ownership, independent of repository build artifacts.
    vi.spyOn(doctorChild, "inspectUpdateDoctorChildSupport").mockResolvedValue(true);
    readPackageVersion.mockResolvedValue(VERSION);
    vi.mocked(updateGitCheckout).mockResolvedValue(
      runtimeRecovery.currentGitCoreFixture(process.cwd(), VERSION).outcome,
    );
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    mockNpmPluginOutcomes([], true);
    let strictValidationEnv: string | undefined;
    vi.mocked(readConfigFileSnapshot).mockImplementation(async (options) => {
      if (!options?.skipPluginValidation) {
        strictValidationEnv = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
      }
      return baseSnapshot;
    });

    await updateCommand({ yes: true, restart: false });

    expect(spawn).not.toHaveBeenCalled();
    expect(resolveGatewayInstallEntrypoint).toHaveBeenCalledTimes(1);
    const doctorCalls = commandCalls().filter(([argv]) => argv.at(-1) === "--doctor");
    expect(doctorCalls).toHaveLength(1);
    expectDelegatedPluginDoctorInput(doctorCalls[0]?.[1].input);
    expect(runExec).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      [FRESH_POST_UPDATE_ENTRYPOINT, "config", "validate", "--json"],
      expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
    );
    expect(strictValidationEnv).toBe("0");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("runs the final fresh doctor for convergence-only current-process changes", async () => {
    // This path exercises delegated Doctor ownership, independent of repository build artifacts.
    vi.spyOn(doctorChild, "inspectUpdateDoctorChildSupport").mockResolvedValue(true);
    mockGitUpdateAfterMutation();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
      changes: ["Repaired configured plugin install records."],
    });

    await updateCommand({ yes: true, restart: false });

    expect(spawn).not.toHaveBeenCalled();
    const doctorCall = commandCalls().find(([argv]) => argv.at(-1) === "--doctor");
    expect(doctorCall?.[1]).toMatchObject({
      env: { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
    });
    const strictValidationCall = vi
      .mocked(runExec)
      .mock.calls.find(([, args]) => args[1] === "config" && args[2] === "validate");
    expect(strictValidationCall?.[2]).toMatchObject({
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
    });
  });

  it("runs the fresh plugin doctor with the selected Node runner", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    await completeChangedPostCorePluginUpdate({ nodeRunner: "/opt/openclaw-service/bin/node" });

    expect(vi.mocked(runExec).mock.calls[0]?.[0]).toBe("/opt/openclaw-service/bin/node");
  });

  it("runs the fresh plugin doctor when the migration owner changed even if config is valid", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate.status).toBe("ok");
    expect(runExec).toHaveBeenCalledTimes(2);
    expect(resolveGatewayInstallEntrypoint).toHaveBeenCalledTimes(1);
  });

  it("records diagnostics as a warning when the fresh plugin doctor cannot run", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    vi.mocked(runExec).mockRejectedValueOnce(
      Object.assign(new Error("Command failed: " + "long-argv-prefix ".repeat(100)), {
        stderr: "doctor process failed: optional plugin repair unavailable",
        stdout: "doctor diagnostic output",
      }),
    );
    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "warning",
      reason: "post-plugin-doctor-execution-failed",
    });
    expect(result.pluginUpdate.warnings?.at(-1)?.message).toContain("doctor process failed");
    expect(result.pluginUpdate.warnings?.at(-1)?.message).toContain("doctor diagnostic output");
    expect(result.pluginUpdate.warnings?.at(-1)?.message).not.toContain("long-argv-prefix");
  });

  it("keeps an invalid config authoritative after a fresh plugin doctor failure", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    const issues = [{ path: "channels.signal.httpUrl", message: "legacy Signal transport field" }];
    vi.mocked(runExec)
      .mockRejectedValueOnce(new Error("doctor process failed"))
      .mockRejectedValueOnce(createConfigValidationFailure(issues));
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce(
      configSnapshot(baseConfig, {
        valid: false,
        issues,
      }),
    );

    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-doctor-invalid-config",
    });
  });

  it("keeps entrypoint resolution failures structured and fail-closed", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockRejectedValueOnce(
      new Error("entrypoint lookup failed"),
    );

    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-doctor-execution-failed",
    });
    expect(result.pluginUpdate.warnings?.[0]?.reason).toContain("entrypoint lookup failed");
    expect(runExec).not.toHaveBeenCalled();
  });

  registerForegroundFailureRecoveryTests({
    setupUpdatedRootRefresh,
    spawn,
    updateCommand,
    defaultRuntime,
    ExitError,
    spawnCall,
    lastWriteJsonCall,
    updateNpmInstalledPlugins,
  });
});
