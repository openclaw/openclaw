import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { createConfigIO } from "../config/io.js";
import { resolveConfigPath } from "../config/paths.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { retainCommandProcessCleanup } from "../process/exec-spawn.js";
import * as versionManagerPath from "../shared/version-manager-path.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import {
  doctorCommandCall,
  expectNoSideEffects,
  expectPackageInstallSpec,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  candidateValidation,
  loadInstalledPluginIndexInstallRecords,
  managedUpdateHandoff,
  nodeVersionSatisfiesEngine,
  pluginAvailabilityPreflight,
  readPackageVersion,
  retainUpdateRuntime,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  sourceRuntimeCompletion,
  syncPluginsForUpdateChannel,
  systemdPolicy,
  updateNpmInstalledPlugins,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  fetchNpmPackageTargetStatus,
  fetchNpmTagVersion,
  getUpdateRun,
  listUpdateRuns,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveNpmChannelTag,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
  runDaemonRestart,
  runExec,
  runPostCorePluginConvergenceSpy,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  mockPostCoreConvergenceOnce,
  postCoreConvergenceResult,
} from "./update-cli/update-cli-config.test-support.js";
import {
  writeJsonFixture,
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import { registerAlreadyCurrentAdmissionTests } from "./update-cli/update-command-current-admission.test-support.js";
import { registerUpdatePreflightTests } from "./update-cli/update-command-preflight.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    configSnapshot,
    createCaseDir,
    FRESH_POST_UPDATE_ENTRYPOINT,
    initializeExistingUpdateProfile,
    mockCurrentProcessFreshDoctor,
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockNpmPluginOutcomes,
    mockPackageInstallAtCaseDir,
    mockRunningManagedGateway,
    primeNpmChannelTag,
    primeServiceCommand,
    profileStateDir,
    setTty,
    setupInstalledPackageRoot,
    statfsFixture,
    tempDirs,
    useFileBackedConfig,
  } = createUpdateCliFixture();

  it.each(runtimeRecovery.alreadyCurrentConvergenceCases)(
    "converges plugins on an already-current core (restart=$restart, running=$running, failure=$failure, platform=$platform)",
    async ({ restart, running, failure, platform }) => {
      if (platform) {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      }
      const root = await mockPackageInstallAtCaseDir();
      await writeOpenClawPackageFixture(root, VERSION);
      mockFileBackedPathExists();
      vi.mocked(resolveGatewayInstallEntrypoint).mockReset();
      readPackageVersion.mockResolvedValue(VERSION);
      primeNpmChannelTag("latest", VERSION);
      if (running) {
        mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
      }
      const installPath = createCaseDir("current-core-plugin");
      await fs.mkdir(installPath, { recursive: true });
      await writeJsonFixture(path.join(installPath, "package.json"), {
        name: "@openclaw/brave-plugin",
        version: "2026.9.2",
      });
      const record: PluginInstallRecord = {
        source: "npm",
        spec: "@openclaw/brave-plugin",
        installPath,
        version: "2026.9.2",
      };
      loadInstalledPluginIndexInstallRecords.mockResolvedValue({ brave: record });
      const updatedRecord = { ...record, version: "2026.9.3" };
      mockNpmPluginOutcomes(
        [
          {
            pluginId: "brave",
            status: "updated",
            currentVersion: "2026.9.2",
            nextVersion: "2026.9.3",
            message: "Updated brave: 2026.9.2 -> 2026.9.3.",
          },
        ],
        true,
        { ...baseConfig, plugins: { ...baseConfig.plugins, installs: { brave: updatedRecord } } },
      );
      runPostCorePluginConvergenceSpy.mockImplementationOnce(async ({ cfg }) => {
        if (failure === "changed owner") {
          primeServiceCommand([
            "node",
            path.join(root, "dist", "index.js"),
            "gateway",
            "run",
            "--port",
            "19102",
          ]);
        }
        return {
          ...postCoreConvergenceResult(),
          config: cfg,
          installRecords: { brave: updatedRecord },
        };
      });

      if (failure === "doctor") {
        const runFixtureExec = requireValue(
          vi.mocked(runExec).getMockImplementation(),
          "fixture exec",
        );
        vi.mocked(runExec).mockImplementation(async (file, args, options) => {
          if (args[1] === "doctor" && args.includes("--repair")) {
            throw new Error("plugin Doctor failed");
          }
          return runFixtureExec(file, args, options);
        });
      } else if (failure === "stop") {
        serviceStop.mockImplementationOnce(async (params: { onMutation?: () => void }) => {
          serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
          params.onMutation?.();
          throw new Error("listener check failed after stop");
        });
      }
      if (failure && failure !== "doctor") {
        await expect(updateCommand({ yes: true, restart, json: true })).rejects.toEqual(
          new ExitError(1),
        );
        expect(serviceStop).toHaveBeenCalledTimes(failure === "changed owner" ? 0 : 1);
        expect(freshRestartCalls()).toHaveLength(0);
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "post-update-plugins",
          ...(failure === "changed owner"
            ? {}
            : { run: { verification: { serviceRunning: false } } }),
        });
        return;
      }
      await updateCommand({ yes: true, restart, json: true });

      expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
        expect.objectContaining({ coreVersion: VERSION, syncOfficialPluginInstalls: true }),
      );
      expect(lastWriteJsonCall()).toMatchObject({
        status: "ok",
        postUpdate: {
          plugins: {
            changed: true,
            status: failure === "doctor" ? "warning" : "ok",
            warnings:
              failure === "doctor"
                ? [
                    expect.objectContaining({
                      reason: "doctor-advisory",
                      message: expect.stringContaining("plugin Doctor failed"),
                    }),
                  ]
                : [],
            npm: { outcomes: [expect.objectContaining({ pluginId: "brave", status: "updated" })] },
          },
        },
      });
      expect(serviceStop).toHaveBeenCalledTimes(restart && running ? 1 : 0);
      expect(freshRestartCalls()).toHaveLength(restart && running ? 1 : 0);
      expect(packageInstallCommandCall()).toBeUndefined();
      expect(candidateValidation).not.toHaveBeenCalled();
      if (failure === "doctor") {
        expect(listUpdateRuns({ limit: 1 })[0]).toMatchObject({
          status: "succeeded",
          verification: { serviceRunning: true, readyz: true },
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "warning:finalize:plugins:0",
              status: "completed",
              detail: expect.stringContaining("plugin Doctor failed"),
            }),
          ]),
        });
      }
      if (!restart) {
        expect(lastWriteJsonCall()).toMatchObject({
          run: {
            origin: {
              nextAction: expect.stringContaining("Gateway restart skipped (--no-restart)"),
            },
          },
        });
      }
      if (restart && running) {
        expect(updateNpmInstalledPlugins.mock.invocationCallOrder[0]).toBeLessThan(
          serviceStop.mock.invocationCallOrder[0]!,
        );
      }
    },
  );

  it("refreshes stale systemd policy on an already-current core without stopping the Gateway", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = await mockPackageInstallAtCaseDir("openclaw-update", VERSION);
    await writeOpenClawPackageFixture(root, VERSION);
    mockFileBackedPathExists();
    vi.mocked(resolveGatewayInstallEntrypoint).mockReset();
    readPackageVersion.mockResolvedValue(VERSION);
    primeNpmChannelTag("latest", VERSION);
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    systemdPolicy.mockResolvedValue(true);

    await updateCommand({ yes: true, json: true });

    expect(systemdPolicy).toHaveBeenCalledWith(expect.objectContaining({ root, stopping: false }));
    expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    expect(lastWriteJsonCall()).toMatchObject({ status: "skipped", reason: "already-current" });
  });

  it.each(runtimeRecovery.alreadyCurrentHandoffCases(VERSION))(
    "keeps the selected target through already-current managed handoff ($packageInstallSpec, $channel)",
    async ({ packageInstallSpec, channel, expectedTag }) => {
      const { finishAlreadyCurrentUpdate } = await import("./update-cli/update-command-noop.js");
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const { pkgRoot: root, entryPath } = await setupInstalledPackageRoot(
        createCaseDir("current-artifact-handoff"),
        VERSION,
      );
      mockFileBackedPathExists();
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entryPath);
      mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      managedUpdateHandoff.start.mockResolvedValue({
        status: "started",
        handoffId: "current-artifact-handoff",
        installRoot: root,
        logPath: "/tmp/current-artifact-handoff.log",
        command: "openclaw update --yes",
        pid: 12345,
      });
      managedUpdateHandoff.transfer.mockResolvedValue(true);
      const refuseUpdate = vi.fn();

      await withEnvAsync({ INVOCATION_ID: "current-artifact-invocation" }, () =>
        finishAlreadyCurrentUpdate({
          root,
          packageInstallSpec,
          opts: { yes: true, json: true },
          result: {
            status: "skipped",
            mode: "npm",
            root,
            reason: "already-current",
            before: { version: VERSION },
            after: { version: VERSION },
            steps: [],
            durationMs: 1,
          },
          requestedChannel: null,
          storedChannel: channel,
          channel,
          shouldRestart: true,
          updateStepTimeoutMs: 1000,
          invocationCwd: process.cwd(),
          startedAt: Date.now(),
          controlPlaneUpdateSentinelMeta: null,
          managedServiceRootRedirect: null,
          stop: vi.fn(),
          refuseUpdate,
        }),
      );

      expect(refuseUpdate).not.toHaveBeenCalled();
      expect(
        managedUpdateHandoff.start.mock.calls.map(([params]) => ({
          root: params.root,
          tag: params.tag,
        })),
      ).toEqual([{ root, tag: expectedTag }]);
      expectNoSideEffects(serviceStop, serviceRestart, updateNpmInstalledPlugins);
    },
  );

  registerAlreadyCurrentAdmissionTests({
    prepareCurrentPackage: async (prefix) => {
      const root = await mockPackageInstallAtCaseDir(prefix, VERSION);
      readPackageVersion.mockResolvedValue(VERSION);
      primeNpmChannelTag("latest", VERSION);
      return root;
    },
    createCaseDir,
    writeServicePackage: (root) =>
      writeOpenClawPackageFixture(root, VERSION, { entrySource: "export {};\n" }),
    mockFileBackedPathExists,
    mockRunningManagedGateway,
    primeServiceCommand,
    useFileBackedConfig,
    resolveConfigPath,
    updateCommand,
    ExitError,
    lastWriteJsonCall,
    getErrorOutput,
    packageInstallCommandCall,
    freshRestartCalls,
    expectNoSideEffects,
    mocks: {
      pluginAvailabilityPreflight,
      syncPluginsForUpdateChannel,
      updateNpmInstalledPlugins,
      replaceConfigFile: vi.mocked(replaceConfigFile),
      serviceStop,
      serviceStart,
      serviceRestart,
    },
  });

  it.each([true, false])(
    "converges a current Git core using its before-only version receipt (runtime compatible=%s)",
    async (compatible) => {
      // This case specifies system-runtime guidance, independent of the host Node manager.
      vi.spyOn(versionManagerPath, "resolveNodeVersionManager").mockReturnValue("system");
      const fixture = runtimeRecovery.currentGitCoreFixture(process.cwd(), VERSION);
      readPackageVersion.mockResolvedValue(VERSION);
      vi.mocked(updateGitCheckout).mockResolvedValueOnce(fixture.outcome);
      nodeVersionSatisfiesEngine.mockReturnValue(compatible);
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
      const command = updateCommand({ yes: true, restart: false, json: true });
      if (compatible) {
        await command;
        expect(pluginAvailabilityPreflight).toHaveBeenCalledWith(
          expect.objectContaining({ targetVersion: VERSION }),
        );
        expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
        expect(lastWriteJsonCall()).toMatchObject(fixture.converged);
      } else {
        await expect(command).rejects.toEqual(new ExitError(1));
        expect(lastWriteJsonCall()).toMatchObject(fixture.runtimeRefusal);
        expectNoSideEffects(pluginAvailabilityPreflight, updateNpmInstalledPlugins);
      }
      expectNoSideEffects(serviceStop, serviceRestart, runDaemonRestart);
    },
  );

  it.each([
    { owner: "dead", cleanup: "joined", profile: "existing" },
    { owner: "live", cleanup: "joined", profile: "existing" },
    { owner: "absent", cleanup: "joined", profile: "existing" },
    { owner: "absent", cleanup: "uncertain", profile: "existing" },
    { owner: "absent", cleanup: "joined", profile: "fresh" },
    { owner: "absent", cleanup: "settlement", profile: "fresh" },
  ] as const)(
    "admits artifacts before already-current Git completion (lock owner: $owner, cleanup: $cleanup, profile: $profile)",
    async ({ owner, cleanup, profile }) => {
      const root = await mockPackageInstallAtCaseDir("current-git-artifacts", VERSION);
      await fs.mkdir(path.join(root, ".git"));
      vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
      vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({
        installKind: "git",
        git: { tag: `v${VERSION}`, branch: "main" },
      });
      const fixture = runtimeRecovery.currentGitCoreFixture(root, VERSION);
      vi.mocked(updateGitCheckout).mockResolvedValueOnce(fixture.outcome);
      readPackageVersion.mockResolvedValue(VERSION);
      mockFileBackedPathExists();
      mockRunningManagedGateway([
        process.execPath,
        path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);
      const runtime = await import("./update-cli/update-command-runtime.js");
      const actualRuntime = await vi.importActual<typeof runtime>(
        "./update-cli/update-command-runtime.js",
      );
      vi.spyOn(runtime, "prepareSourceUpdateRuntime").mockImplementation(
        actualRuntime.prepareSourceUpdateRuntime,
      );
      const lock = path.join(root, ".artifacts", "dist-artifacts.lock");
      const ownerFile = path.join(lock, "owner.json");
      const freshState = createCaseDir("fresh-current-state");
      const runEnv =
        profile === "fresh"
          ? {
              OPENCLAW_STATE_DIR: freshState,
              OPENCLAW_CONFIG_PATH: path.join(freshState, "openclaw.json"),
            }
          : undefined;
      let heldAtSettlement: boolean | undefined;
      if (runEnv) {
        const executorOwner = await import("./update-cli/update-command-executor.js");
        const withExecutor = executorOwner.withUpdateCommandExecutor;
        vi.spyOn(executorOwner, "withUpdateCommandExecutor").mockImplementation(
          (runId, operation, options) =>
            withExecutor(
              runId,
              async (executor) => {
                const result = await operation(executor);
                heldAtSettlement = fsSync.existsSync(ownerFile);
                if (cleanup === "settlement") {
                  retainCommandProcessCleanup(Promise.resolve("uncertain"));
                }
                return result;
              },
              options,
            ),
        );
      }
      const pid = owner === "live" ? process.pid : 0x7fff_ffff;
      const ownerRecord = JSON.stringify({ pid, startedAt: "2026-09-20T01:00:00.000Z" });
      if (owner !== "absent") {
        await fs.mkdir(lock, { recursive: true });
        await fs.writeFile(ownerFile, ownerRecord);
      }
      sourceRuntimeCompletion.mockImplementation(async ({ artifactOwnership }) => {
        expect(artifactOwnership).toBeDefined();
        await artifactOwnership?.assertOwned();
        expect(JSON.parse(await fs.readFile(ownerFile, "utf8"))).toMatchObject({
          pid: process.pid,
        });
        if (cleanup === "uncertain") {
          expect((await fs.readdir(lock)).some((entry) => entry.startsWith("child-"))).toBe(false);
          throw new CommandProcessCleanupError();
        }
        return { changed: false };
      });

      const command = withEnvAsync(runEnv ?? {}, async () => {
        if (runEnv) {
          await useFileBackedConfig();
          const { snapshot } = await createConfigIO({
            env: process.env,
            observe: false,
            pluginValidation: "core-only",
          }).readConfigFileSnapshotForWrite();
          vi.mocked(readConfigFileSnapshot).mockResolvedValue(snapshot);
        }
        await updateCommand({ yes: true, json: true });
      });
      if (cleanup === "uncertain" || cleanup === "settlement") {
        const error = await command.catch((cause: unknown) => cause);
        expect(hasCommandProcessCleanupError(error)).toBe(true);
        expect(JSON.parse(await fs.readFile(ownerFile, "utf8"))).toMatchObject({
          pid: process.pid,
        });
        expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
        if (cleanup === "uncertain") {
          expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
        } else {
          expect(heldAtSettlement).toBe(true);
        }
        return;
      }
      if (owner === "absent") {
        await command;
        expect(sourceRuntimeCompletion).toHaveBeenCalledOnce();
        expect(lastWriteJsonCall()).toMatchObject(fixture.converged);
        if (profile === "fresh") {
          expect(heldAtSettlement).toBe(true);
        }
        await expect(fs.stat(ownerFile)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(command).rejects.toEqual(new ExitError(1));
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "source-artifact-ownership",
        });
        expect(getErrorOutput()).toContain(`retained by PID ${pid}`);
        expect(getErrorOutput()).toContain(lock);
        expect(await fs.readFile(ownerFile, "utf8")).toBe(ownerRecord);
        expectNoSideEffects(sourceRuntimeCompletion, updateNpmInstalledPlugins);
      }
      const result = lastWriteJsonCall() as UpdateRunResult;
      expect(
        getUpdateRun(requireValue(result.runId, "artifact admission run"), { env: runEnv }),
      ).toMatchObject({
        status: owner === "absent" ? "skipped" : "failed",
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "source-artifact-ownership",
            status: owner === "absent" ? "completed" : "failed",
          }),
        ]),
      });
      expectNoSideEffects(serviceStop, serviceStart, serviceRestart, candidateValidation);
    },
  );

  it.each([false, true])(
    "reports retained pins on an already-current core (json=%s)",
    async (json) => {
      const root = await mockPackageInstallAtCaseDir();
      await writeOpenClawPackageFixture(root, VERSION);
      readPackageVersion.mockResolvedValue(VERSION);
      primeNpmChannelTag("latest", VERSION);
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
      const installPath = createCaseDir("current-core-pin");
      await fs.mkdir(installPath, { recursive: true });
      await writeJsonFixture(path.join(installPath, "package.json"), {
        name: "@openclaw/discord",
        version: "2026.9.2",
      });
      const records: Record<string, PluginInstallRecord> = {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@2026.9.2",
          installPath,
          version: "2026.9.2",
        },
      };
      loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      const message =
        "discord is pinned to @openclaw/discord@2026.9.2 (installed 2026.9.2); registry latest resolves to 2026.9.3. Pass `openclaw plugins update @openclaw/discord@latest` to replace this version pin.";
      mockNpmPluginOutcomes(
        [
          {
            pluginId: "discord",
            status: "unchanged",
            currentVersion: "2026.9.2",
            nextVersion: "2026.9.3",
            message,
          },
        ],
        false,
        { ...baseConfig, plugins: { ...baseConfig.plugins, installs: records } },
      );
      mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
        installRecords: records,
      });

      await updateCommand({ yes: true, json });

      expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      expectNoSideEffects(serviceStop, serviceRestart, runDaemonRestart);
      expect(freshRestartCalls()).toHaveLength(0);
      if (json) {
        expect(lastWriteJsonCall()).toMatchObject({
          status: "skipped",
          reason: "already-current",
          postUpdate: {
            plugins: {
              status: "warning",
              changed: false,
              warnings: [
                expect.objectContaining({
                  pluginId: "discord",
                  reason: "retained-plugin-pin",
                  message: expect.stringContaining(message),
                }),
              ],
            },
          },
        });
      } else {
        expect(stripAnsi(getLogOutput())).toContain(message);
      }
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).not.toHaveBeenCalled();
      expect(records.discord?.spec).toBe("@openclaw/discord@2026.9.2");
    },
  );

  it.each([true, false])(
    "never stops an unchanged same-version managed gateway (restart=%s)",
    async (restart) => {
      const root = await mockPackageInstallAtCaseDir("openclaw-current-package", VERSION);
      readPackageVersion.mockResolvedValue(VERSION);
      primeNpmChannelTag("latest", VERSION);
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);

      await updateCommand({ yes: true, restart, json: true });

      expectNoSideEffects(serviceStop, serviceRestart, runDaemonRestart, candidateValidation);
      expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(lastWriteJsonCall()).toMatchObject({ status: "skipped", reason: "already-current" });
      const result = lastWriteJsonCall() as UpdateRunResult;
      expect(getUpdateRun(requireValue(result.runId, "no-op run id"))).toMatchObject({
        status: "skipped",
        reason: "already-current",
        downtimeMs: 0,
      });
    },
  );

  it("reports a same-version channel switch as successful without updating the package", async () => {
    const root = await mockPackageInstallAtCaseDir("openclaw-current-package", VERSION);
    const stateDir = tempDirs.make("openclaw-update-channel-switch-");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    readPackageVersion.mockResolvedValue(VERSION);
    primeNpmChannelTag("beta", VERSION);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
      configSnapshot({ update: { channel: "stable" } }),
    );
    await writeJsonFixture(path.join(stateDir, "openclaw.json"), {
      update: { channel: "stable" },
    });
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await updateCommand({ channel: "beta", yes: true, restart: true, json: true });
    });

    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("beta");
    expectNoSideEffects(serviceStop, serviceRestart, runDaemonRestart, candidateValidation);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(doctorCommandCall()).toBeUndefined();
    expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
    expect(lastWriteJsonCall()).not.toHaveProperty("reason");
    const result = lastWriteJsonCall() as UpdateRunResult;
    expect(
      getUpdateRun(requireValue(result.runId, "channel switch run id"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toMatchObject({ status: "succeeded", downtimeMs: 0 });
  });

  it("keeps an explicit same-version channel no-op skipped without snapshot capacity or config rewrites", async () => {
    const root = await mockPackageInstallAtCaseDir("openclaw-current-package", VERSION);
    const stateDir = tempDirs.make("openclaw-update-channel-noop-");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    readPackageVersion.mockResolvedValue(VERSION);
    primeNpmChannelTag("beta", VERSION);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
      configSnapshot({ update: { channel: "beta" } }),
    );
    await writeJsonFixture(path.join(stateDir, "openclaw.json"), {
      update: { channel: "beta" },
    });
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);

    vi.spyOn(fsSync, "statfsSync").mockReturnValue(statfsFixture({ bavail: 0 }));

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await updateCommand({ channel: "beta", yes: true, restart: true, json: true });
    });

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expectNoSideEffects(serviceStop, serviceRestart, runDaemonRestart, candidateValidation);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(doctorCommandCall()).toBeUndefined();
    expect(lastWriteJsonCall()).toMatchObject({ status: "skipped", reason: "already-current" });
  });

  it("completes an equal-version Git-to-package switch", async () => {
    const { nodeModules, pkgRoot } = await setupInstalledPackageRoot(
      createCaseDir("openclaw-git-to-package-same-version"),
      VERSION,
    );
    await fs.writeFile(path.join(pkgRoot, "dist", "index.js"), "git runtime\n");
    await writePackageDistInventory(pkgRoot);
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] !== "npm" || argv[1] !== "i") {
        return;
      }
      await writeNpmPackageInstall(argv, pkgRoot, VERSION);
      const stagePrefix = requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
      const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
      await fs.writeFile(path.join(stageRoot, "dist", "index.js"), "package runtime\n");
      await writePackageDistInventory(stageRoot);
    });
    mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
    vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({
      installKind: "git",
      git: { tag: `v${VERSION}`, branch: "main" },
    });
    readPackageVersion.mockImplementation(async (root: string) => {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
        version: string;
      };
      return manifest.version;
    });
    primeNpmChannelTag("latest", VERSION);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
      configSnapshot({ update: { channel: "dev" } }),
    );

    await updateCommand({ channel: "stable", yes: true, restart: false, json: true });

    expectPackageInstallSpec(`openclaw@${VERSION}`);
    expect(candidateValidation).toHaveBeenCalled();
    await expect(fs.readFile(path.join(pkgRoot, "dist", "index.js"), "utf8")).resolves.toBe(
      "package runtime\n",
    );
    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("stable");
    expect(lastWriteJsonCall()).toMatchObject({
      status: "ok",
      mode: "npm",
      root: pkgRoot,
    });
    expect((lastWriteJsonCall() as UpdateRunResult).reason).toBeUndefined();
  });

  it("runs the package update when latest target lookup is unresolved", async () => {
    setTty(false);
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.4.22");
    primeNpmChannelTag("latest", null);
    mockCurrentProcessFreshDoctor();

    await updateCommand({});

    expect(getErrorOutput()).not.toContain("Downgrade confirmation required.");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expectPackageInstallSpec("openclaw@latest");
    expect(vi.mocked(runExec).mock.calls.filter(([, args]) => args[1] === "doctor")).toEqual([]);
  });

  it("blocks the package update when a non-latest dist-tag lookup is unresolved", async () => {
    setTty(false);
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.4.22");
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "next",
      version: null,
      error: "HTTP 404",
    });

    await updateCommand({ tag: "next" });

    expect(getErrorOutput()).toContain("Downgrade confirmation required.");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  registerUpdatePreflightTests({
    mockPackageInstallAtCaseDir,
    mockCurrentProcessFreshDoctor,
    statfsFixture,
    resolveNpmChannelTag,
    fetchNpmPackageTargetStatus,
    listUpdateRuns,
    updateCommand,
    getLogOutput,
    getErrorOutput,
    lastWriteJsonCall,
    expectPackageInstallSpec,
    packageInstallCommandCall,
    defaultRuntime,
    retainUpdateRuntime,
    initializeExistingUpdateProfile,
    profileStateDir,
    makeTempDir: (prefix) => tempDirs.make(prefix),
  });
});
