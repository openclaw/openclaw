import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as configIo from "../config/io.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { VERSION } from "../version.js";
import {
  commandCalls,
  completionCommandCall,
  expectNoSideEffects,
  freshRestartCalls,
  gatewayCommandCall,
  getErrorOutput,
  getLogOutput,
  requireValue,
  spawnCall,
  getTriageFailures,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  loadInstalledPluginIndexInstallRecords,
  pathExists,
  readPackageVersion,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStop,
  spawn,
  syncPluginsForUpdateChannel,
  unrelatedGatewayFixturePid,
  updateNpmInstalledPlugins,
  callGateway,
  restorePersistedInstalledPluginIndexIfCurrent,
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./update-cli-mocks.test-support.js";
import {
  continuePostCoreUpdateInFreshProcess,
  defaultRuntime,
  doctorCommand,
  getUpdateRun,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  readConfigFileSnapshot,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
  runDaemonRestart,
  runExec,
  updateCommand,
  ExitError,
} from "./update-cli-modules.test-support.js";
import { pluginSyncResult } from "./update-cli/update-cli-config.test-support.js";
import {
  writeGitUpdateResultFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const {
    baseConfig,
    baseSnapshot,
    configSnapshot,
    FRESH_POST_UPDATE_ENTRYPOINT,
    initializeExistingUpdateProfile,
    primeServiceCommand,
    profileStateDir,
    setupManagedGitRootRefresh,
    setupUpdatedRootRefresh,
    tempDirs,
    mockPackageInstallAtCaseDir,
  } = createUpdateCliFixture();

  const continueFreshPostCore = () =>
    continuePostCoreUpdateInFreshProcess({
      root: "/tmp/openclaw-updated-root",
      channel: "stable",
      requestedChannel: null,
      opts: {},
      pluginInstallRecords: {},
      updateStartedAtMs: 123,
      timeoutMs: 30_000,
    });

  it("keeps stopped owned-service config and plugin state through fresh post-core handoff", async () => {
    const updatedEntrypoint = await setupManagedGitRootRefresh(true);
    const managedState = profileStateDir("work");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: managedState });
    const personalState = profileStateDir("personal");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: personalState });
    const managedConfig = {
      ...baseConfig,
      update: { channel: "beta" as const },
    };
    const managedSnapshot = configSnapshot(managedConfig, {
      path: path.join(managedState, "openclaw.json"),
    });
    const managedRecords = {
      telegram: { source: "npm", spec: "@openclaw/telegram@beta" },
    } satisfies Record<string, PluginInstallRecord>;
    primeServiceCommand(
      [nodeExecutable, path.join(process.cwd(), "dist", "index.js"), "gateway", "run"],
      {
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: managedState,
        OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
        OPENCLAW_GATEWAY_PORT: "19222",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(unrelatedGatewayFixturePid),
      },
    );
    const snapshotForEnv = (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_PROFILE === "work" ? managedSnapshot : baseSnapshot;
    vi.mocked(readConfigFileSnapshot).mockImplementation(async () => snapshotForEnv());
    const createConfigIO = configIo.createConfigIO;
    vi.spyOn(configIo, "createConfigIO").mockImplementation((options) => ({
      ...createConfigIO(options),
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: snapshotForEnv(options?.env),
        writeOptions: {},
      }),
    }));
    loadInstalledPluginIndexInstallRecords.mockImplementation(async (options = {}) =>
      options.env?.OPENCLAW_PROFILE === "work" ? managedRecords : {},
    );
    let handedConfig: unknown;
    let handedRecords: unknown;
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      handedConfig = JSON.parse(
        fsSync.readFileSync(env?.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH ?? "", "utf-8"),
      );
      handedRecords = JSON.parse(
        fsSync.readFileSync(env?.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH ?? "", "utf-8"),
      );
      const child = new EventEmitter() as EventEmitter & { once: EventEmitter["once"] };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: personalState,
        OPENCLAW_CONFIG_PATH: path.join(personalState, "openclaw.json"),
        OPENCLAW_GATEWAY_PORT: "19111",
      },
      async () => {
        await updateCommand({ yes: true, timeout: "1800" });
        expect(process.env.OPENCLAW_PROFILE).toBe("personal");
      },
    );

    const handoff = spawnCall();
    const handoffEnv = requireValue(handoff?.[2]?.env, "post-core environment");
    expect(
      getUpdateRun(requireValue(handoffEnv.OPENCLAW_UPDATE_RUN_ID, "update run id"), {
        env: handoffEnv,
      })?.trigger,
    ).toBe("cli");
    expect(handoff?.[0]).toBe(process.execPath);
    expect(handoff?.[1]).toEqual([updatedEntrypoint, "update", "--yes", "--timeout", "1800"]);
    expect(handoff?.[2]?.stdio).toBe("inherit");
    expect(handoff?.[2]?.env).toMatchObject({
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_POST_CORE: "1",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
    });
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(completionCommandCall()?.[1]).toMatchObject({ env: { OPENCLAW_PROFILE: "personal" } });
    expect(serviceStop).toHaveBeenCalledOnce();
    expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    expect(freshRestartCalls()).toHaveLength(1);
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
    expect(spawnCall()?.[2]?.env).toMatchObject({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: "19222",
    });
    expect(spawnCall()?.[2]?.env?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
    expect(spawnCall()?.[2]?.env?.[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBeUndefined();
    expect(handedConfig).toEqual({ sourceConfig: managedConfig, authoredConfig: managedConfig });
    expect(handedRecords).toEqual(managedRecords);
    const restartIndex = commandCalls().findIndex(
      ([argv]) => argv[2] === "gateway" && argv[3] === "restart",
    );
    expect(vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[restartIndex]).toBeGreaterThan(
      requireValue(spawn.mock.invocationCallOrder[0], "post-core handoff"),
    );
  });

  it("keeps foreign-service updates in the caller profile", async () => {
    const personalState = profileStateDir("personal");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: personalState });
    const { root, entrypoints } = setupUpdatedRootRefresh();
    const foreignRoot = tempDirs.make("openclaw-update-foreign-profile-");
    const foreignEntrypoint = await writeOpenClawPackageFixture(foreignRoot, "2026.4.21", {
      entrySource: "export {};\n",
    });
    mockGitUpdateAfterMutation(
      await writeGitUpdateResultFixture({
        root,
        before: { sha: "old-caller-sha", version: "2026.4.26" },
        after: { sha: "new-caller-sha", version: VERSION },
      }),
    );
    serviceReadCommand.mockResolvedValue({
      programArguments: [nodeExecutable, foreignEntrypoint, "gateway", "run"],
      environment: {
        OPENCLAW_PROFILE: "foreign",
        OPENCLAW_STATE_DIR: profileStateDir("foreign"),
        OPENCLAW_GATEWAY_PORT: "19333",
      },
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    pathExists.mockImplementation(
      async (candidate: string) =>
        entrypoints.includes(candidate) || candidate.endsWith("package.json"),
    );
    initializeExistingUpdateProfile({
      ...process.env,
      OPENCLAW_STATE_DIR: profileStateDir("work"),
    });
    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: personalState,
        OPENCLAW_GATEWAY_PORT: "19111",
      },
      async () => {
        await updateCommand({ yes: true });
      },
    );

    expect(serviceStop).not.toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(spawnCall()?.[2]?.env).toMatchObject({
      OPENCLAW_PROFILE: "personal",
      OPENCLAW_STATE_DIR: personalState,
      OPENCLAW_GATEWAY_PORT: "19111",
    });
  });

  it("keeps forced post-core fallback and fresh validation in the stopped service profile", async () => {
    const updatedEntrypoint = await setupManagedGitRootRefresh();
    const managedState = profileStateDir("work");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: managedState });
    primeServiceCommand(
      [nodeExecutable, path.join(process.cwd(), "dist", "index.js"), "gateway", "run"],
      {
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: managedState,
        OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
        OPENCLAW_GATEWAY_PORT: "19222",
      },
    );
    // Only the resume attempt misses; Doctor and service refresh resolve the real target.
    let resumeAttempted = false;
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockImplementation(async () => {
        if (serviceStop.mock.calls.length > 0 && !resumeAttempted) {
          resumeAttempted = true;
          return undefined;
        }
        return updatedEntrypoint;
      });
    const convergenceProfiles: Array<string | undefined> = [];
    syncPluginsForUpdateChannel.mockImplementation(async () => {
      convergenceProfiles.push(process.env.OPENCLAW_PROFILE);
      return pluginSyncResult(baseConfig, true);
    });

    initializeExistingUpdateProfile({
      ...process.env,
      OPENCLAW_STATE_DIR: profileStateDir("personal"),
    });
    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: profileStateDir("personal"),
        OPENCLAW_GATEWAY_PORT: "19111",
      },
      async () => {
        await updateCommand({ yes: true }).catch((error: unknown) => {
          throw new Error(getErrorOutput() + getLogOutput(), { cause: error });
        });
        expect(process.env.OPENCLAW_PROFILE).toBe("personal");
      },
    );

    expect(convergenceProfiles).toEqual(["work"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    expect(freshRestartCalls()).toHaveLength(1);
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
    const freshCalls = vi
      .mocked(runExec)
      .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? ""));
    expect(freshCalls).toHaveLength(2);
    for (const call of freshCalls) {
      expect(call[1][0]).toBe(updatedEntrypoint);
      const options = call[2];
      const baseEnv = typeof options === "number" ? undefined : options?.baseEnv;
      expect(baseEnv).toMatchObject({
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: managedState,
        OPENCLAW_GATEWAY_PORT: "19222",
      });
    }
  });

  it("routes JSON post-core child output to stderr", async () => {
    const { entrypoints } = setupUpdatedRootRefresh();
    const stdoutPipe = vi.fn();
    const stderrPipe = vi.fn();
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
        stdout: { pipe: typeof stdoutPipe };
        stderr: { pipe: typeof stderrPipe };
      };
      child.stdout = { pipe: stdoutPipe };
      child.stderr = { pipe: stderrPipe };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });

    await updateCommand({ json: true, restart: false });

    const call = spawnCall();
    expect(call?.[1]).toEqual([
      entrypoints[0],
      "update",
      "--json",
      "--no-restart",
      "--timeout",
      "1800",
    ]);
    expect(call?.[2]?.stdio).toBe("pipe");
    expect(stdoutPipe).toHaveBeenCalledWith(process.stderr);
    expect(stdoutPipe).not.toHaveBeenCalledWith(process.stdout);
    expect(stderrPipe).toHaveBeenCalledWith(process.stderr);
  });

  it("keeps the candidate stopped through plugin convergence and only restarts the verified previous version despite its plugin errors", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const root = await mockPackageInstallAtCaseDir();
    const entryPath = path.join(root, "dist", "index.js");
    vi.mocked(resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(entryPath);
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(
      [nodeExecutable, entryPath, "gateway", "run"],
      undefined,
      resolveGatewayTaskScriptPath(process.env),
    );
    pathExists.mockImplementation(async (candidate: string) => candidate === entryPath);
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "1.0.0", connId: "previous-gateway", bootId: "previous-boot" },
        health: {
          ok: true,
          plugins: {
            errors: [{ id: "demo", origin: "global", activated: true, error: "load failed" }],
          },
        },
      }),
    );
    const activations: Array<{ version: string; afterPlugin: boolean }> = [];
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "staged package commands",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[2] === "gateway" && ["install", "restart"].includes(argv[3] ?? "")) {
        const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        activations.push({ version: manifest.version, afterPlugin: spawn.mock.calls.length > 0 });
      }
      return runFixtureCommand(argv, options);
    });
    spawn.mockImplementationOnce((_command: unknown, _argv: unknown, options: unknown) => {
      const resultPath = (options as { env?: NodeJS.ProcessEnv }).env
        ?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
      if (!resultPath) {
        throw new Error("missing post-core result path");
      }
      queueMicrotask(() => {
        void fs.writeFile(
          resultPath,
          JSON.stringify({
            status: "error",
            changed: false,
            warnings: [
              {
                pluginId: "demo",
                reason: "missing-extension-entry: ./dist/index.js",
                message:
                  'Plugin "demo" failed post-core payload smoke check (missing-extension-entry): ./dist/index.js',
                guidance: ["Run openclaw update repair to retry post-update plugin repair."],
              },
            ],
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
                {
                  pluginId: "demo",
                  status: "error",
                  message: "Plugin extension entry missing",
                },
              ],
            },
            integrityDrifts: [],
          }),
          "utf-8",
        );
      });
      const child = new EventEmitter() as EventEmitter & {
        kill: () => boolean;
        once: EventEmitter["once"];
      };
      child.kill = vi.fn(() => {
        queueMicrotask(() => {
          child.emit("exit", null, "SIGTERM");
          child.emit("close", null, "SIGTERM");
        });
        return true;
      });
      return child;
    });

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
    platformSpy.mockRestore();

    expect(serviceStop).toHaveBeenCalled();
    expectNoSideEffects(serviceRestart, runDaemonRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getLogOutput()).not.toContain("Update Result: OK");
    expect(spawn).toHaveBeenCalled();
    expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
    const pluginStartOrder = requireValue(spawn.mock.invocationCallOrder[0], "plugin child start");
    const starts = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.flatMap(([argv], index) =>
        argv[2] === "gateway" && ["install", "restart"].includes(argv[3] ?? "")
          ? [
              requireValue(
                vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[index],
                "gateway activation order",
              ),
            ]
          : [],
      );
    expect(starts.length).toBeGreaterThan(0);
    expect(activations.filter((entry) => !entry.afterPlugin)).toEqual([]);
    expect(activations.filter((entry) => entry.afterPlugin)).toEqual([
      { version: "1.0.0", afterPlugin: true },
    ]);
    expect(gatewayCommandCall(entryPath, "install")).toBeUndefined();
    expect(gatewayCommandCall(entryPath, "restart")?.[0]).toContain("--preserve-definition");
    expect(resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(
      pluginStartOrder,
    );
  });

  it.each(["spawn", "phase"])(
    "restores the exact plugin index revision when post-core %s fails",
    async (failureKind) => {
      const { root } = setupUpdatedRootRefresh({
        admitMutation: true,
        targetVersion: "2026.4.29",
        gatewayUpdateImpl: async (updatedRoot) =>
          makeOkUpdateResult({
            mode: "npm",
            root: updatedRoot,
            before: { version: "2026.5.28" },
            after: { version: "2026.4.29" },
          }),
      });
      readPackageVersion.mockImplementation(async (pkgRoot: string) =>
        pkgRoot === root ? "2026.4.29" : "2026.5.28",
      );
      const previousPersistedIndex = {
        policyHash: "previous-policy",
        installRecords: {
          msteams: {
            source: "npm",
            spec: "@openclaw/msteams",
            resolvedVersion: "2026.5.28",
          },
        } satisfies Record<string, PluginInstallRecord>,
      };
      writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
        previous: previousPersistedIndex as never,
        revision: 17,
      });
      loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(
        previousPersistedIndex.installRecords,
      );
      spawn.mockImplementationOnce((_node, _argv, options) => {
        if (failureKind === "spawn") {
          throw new Error("post-core spawn failed");
        }
        const child = new EventEmitter();
        fsSync.writeFileSync(
          options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH,
          JSON.stringify({
            status: "failed",
            error: "pre-plugin Doctor failed before convergence",
          }),
        );
        queueMicrotask(() => {
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        });
        return child;
      });

      await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
      expect(getTriageFailures()).toContainEqual(
        expect.objectContaining({
          error:
            failureKind === "spawn"
              ? "post-core spawn failed"
              : "pre-plugin Doctor failed before convergence",
          result: expect.objectContaining({
            status: "error",
            mode: "npm",
            root,
            before: { version: "2026.5.28" },
            after: { version: "2026.4.29" },
          }),
        }),
      );
      expect(defaultRuntime.exit).not.toHaveBeenCalled();

      expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledTimes(1);
      expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
        previousPersistedIndex,
        17,
        { lease: expect.anything() },
      );
    },
  );

  it("joins Windows taskkill after the committed post-core child closes", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    readPackageVersion.mockResolvedValueOnce(null);
    const helperStarted = createDeferred();
    const releaseHelper = createDeferred();
    let helperSettled = false;
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawn.mockImplementationOnce((_node, _args, options) => {
      fsSync.writeFileSync(
        options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH,
        JSON.stringify({ status: "ok" }),
      );
      return child;
    });
    vi.mocked(runExec).mockImplementationOnce(async (command, args) => {
      expect(command).toMatch(/taskkill\.exe$/);
      expect(args).toEqual(["/PID", "4242", "/T", "/F"]);
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
      helperStarted.resolve();
      await releaseHelper.promise;
      helperSettled = true;
      return { stdout: "", stderr: "" };
    });
    const updating = continueFreshPostCore();
    const settled = vi.fn();
    void updating.then(settled, settled);
    try {
      await Promise.race([
        helperStarted.promise,
        updating.then(() => {
          throw new Error("post-core returned before stopping its child");
        }),
      ]);
      await nextTurn();
      expect(settled).not.toHaveBeenCalled();
      releaseHelper.resolve();
      const result = await updating;
      expect(result).toEqual({ resumed: true, pluginUpdate: { status: "ok" } });
      expect(helperSettled).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      releaseHelper.resolve();
      await Promise.allSettled([updating]);
      platformSpy.mockRestore();
    }
  });

  it.each(["overlapping-reads", "close-before-read", "termination-error"] as const)(
    "preserves a committed post-core result after writer settlement (%s)",
    async (race) => {
      const overlapping = race === "overlapping-reads";
      if (overlapping) {
        setupUpdatedRootRefresh();
      } else {
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
          FRESH_POST_UPDATE_ENTRYPOINT,
        );
        readPackageVersion.mockResolvedValueOnce(null);
      }
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      const reading = createDeferred();
      const releaseRead = createDeferred();
      let resultPath: string | undefined;
      let resultReads = 0;
      const jsonFiles = await import("../infra/json-files.js");
      const read = jsonFiles.readJsonIfExists;
      const pendingReads: Promise<unknown>[] = [];
      const readSpy = vi
        .spyOn(jsonFiles, "readJsonIfExists")
        .mockImplementation(<T>(...args: Parameters<typeof read>) => {
          const pending = read<T>(...args).then(async (value) => {
            if (race !== "termination-error" && args[0] === resultPath) {
              if (++resultReads === (overlapping ? 2 : 1)) {
                reading.resolve();
              }
              await releaseRead.promise;
            }
            return value;
          });
          pendingReads.push(pending);
          return pending;
        });
      spawn.mockImplementationOnce((_node, _args, options) => {
        resultPath = options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
        fsSync.writeFileSync(
          requireValue(resultPath, "committed child result"),
          JSON.stringify({ status: "ok" }),
        );
        if (race !== "close-before-read") {
          child.kill.mockImplementation(() => {
            queueMicrotask(() => {
              child.emit("exit", overlapping ? null : 0, overlapping ? "SIGTERM" : null);
              child.emit("close", overlapping ? null : 0, overlapping ? "SIGTERM" : null);
            });
            if (race === "termination-error") {
              throw new Error("signal delivery failed after result commit");
            }
            return true;
          });
        }
        return child;
      });
      const updating = overlapping
        ? updateCommand({ yes: true, restart: false })
        : continueFreshPostCore();
      const outcome = updating.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        if (race !== "termination-error") {
          await Promise.race([
            reading.promise,
            updating.then(() => {
              throw new Error("update finished before held result reads");
            }),
          ]);
          if (!overlapping) {
            child.emit("exit", null, "SIGTERM");
            child.emit("close", null, "SIGTERM");
          }
          releaseRead.resolve();
        }
        if (overlapping) {
          await updating;
          await Promise.all(pendingReads);
          expect(child.kill).toHaveBeenCalledTimes(1);
          expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
          expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
        } else {
          expect(await outcome).toEqual({
            result: { resumed: true, pluginUpdate: { status: "ok" } },
          });
          if (race === "close-before-read") {
            expect(child.kill).not.toHaveBeenCalled();
          }
        }
      } finally {
        releaseRead.resolve();
        await Promise.allSettled([updating, ...pendingReads]);
        readSpy.mockRestore();
      }
    },
  );
});
