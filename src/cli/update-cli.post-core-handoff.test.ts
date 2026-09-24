import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import { withEnvAsync } from "../test-utils/env.js";
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
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  gatewayFixturePid,
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
  runDaemonInstall,
  runDaemonRestart,
  runExec,
  updateCommand,
} from "./update-cli-modules.test-support.js";
import { pluginSyncResult } from "./update-cli/update-cli-config.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    baseSnapshot,
    configSnapshot,
    FRESH_POST_UPDATE_ENTRYPOINT,
    initializeExistingUpdateProfile,
    mockGatewayHealth,
    mockOwnedGitService,
    primeServiceCommand,
    profileStateDir,
    setupManagedGitRootRefresh,
    setupUpdatedRootRefresh,
    tempDirs,
  } = createUpdateCliFixture();

  it("respawns into the updated package root before running post-update tasks", async () => {
    const { entrypoints } = setupUpdatedRootRefresh();

    await updateCommand({ yes: true, timeout: "1800" });

    const call = spawnCall();
    expect(call?.[0]).toMatch(/node/);
    expect(call?.[1]).toEqual([entrypoints[0], "update", "--yes", "--timeout", "1800"]);
    expect(call?.[2]?.stdio).toBe("inherit");
    expect(call?.[2]?.env?.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
    expect(getUpdateRun(call?.[2]?.env?.OPENCLAW_UPDATE_RUN_ID ?? "")?.trigger).toBe("cli");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("dev");
    expect(call?.[2]?.env?.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe(VERSION);
    expect(vi.mocked(readConfigFileSnapshot).mock.calls[1]?.[0]).toEqual({
      skipPluginValidation: true,
      observe: false,
      suppressFutureVersionWarning: true,
    });
    expectNoSideEffects(updateNpmInstalledPlugins, runDaemonInstall, runDaemonRestart);
  });

  it("isolates stale handoff values at the post-core CLI spawn boundary", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    readPackageVersion.mockResolvedValueOnce(null);

    await withEnvAsync(
      {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "stale-version",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "beta",
        OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: "/tmp/stale-config.json",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(unrelatedGatewayFixturePid),
        OPENCLAW_UNRELATED: "preserved",
      },
      async () => {
        await continuePostCoreUpdateInFreshProcess({
          root: "/tmp/openclaw-updated-root",
          channel: "stable",
          requestedChannel: null,
          opts: {},
          pluginInstallRecords: {},
          updateStartedAtMs: 123,
          timeoutMs: 30_000,
        });

        expect(spawn).toHaveBeenCalledOnce();
        const env = spawnCall()?.[2]?.env;
        expect(env?.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        expect(env?.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBeUndefined();
        expect(env?.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH).toBeUndefined();
        expect(env?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
        expect(env?.OPENCLAW_SERVICE_KIND).toBeUndefined();
        expect(env?.[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBeUndefined();
        expect(env?.OPENCLAW_UNRELATED).toBe("preserved");
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("stale-version");
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("beta");
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH).toBe(
          "/tmp/stale-config.json",
        );
      },
    );
  });

  it.each([false, true])(
    "keeps stopped owned-service config and plugin state through fresh post-core handoff (reinspect=%s)",
    async (reinspect) => {
      const updatedEntrypoint = await setupManagedGitRootRefresh(reinspect);
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
        ["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"],
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
      vi.mocked(readConfigFileSnapshot).mockImplementation(async () =>
        process.env.OPENCLAW_PROFILE === "work" ? managedSnapshot : baseSnapshot,
      );
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
          await updateCommand({ yes: true });
        },
      );

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
      expect(
        vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[restartIndex],
      ).toBeGreaterThan(requireValue(spawn.mock.invocationCallOrder[0], "post-core handoff"));
    },
  );

  it("keeps foreign-service updates in the caller profile", async () => {
    const personalState = profileStateDir("personal");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: personalState });
    const { root, entrypoints } = setupUpdatedRootRefresh();
    const foreignRoot = tempDirs.make("openclaw-update-foreign-profile-");
    const foreignEntrypoint = await writeOpenClawPackageFixture(foreignRoot, "2026.4.21", {
      entrySource: "export {};\n",
    });
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root,
        before: { sha: "old-caller-sha", version: "2026.4.26" },
        after: { sha: "new-caller-sha", version: VERSION },
      }),
    );
    serviceReadCommand.mockResolvedValue({
      programArguments: ["node", foreignEntrypoint, "gateway", "run"],
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
    primeServiceCommand(["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: "19222",
    });
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

  it("finishes a human restart without rerunning stale doctor or leaking the service profile", async () => {
    mockOwnedGitService();
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({ root: process.cwd(), after: { version: VERSION } }),
    );
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(process.cwd(), "dist", "index.js"),
    );
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === path.join(process.cwd(), "package.json") ||
        candidate === path.join(process.cwd(), "dist", "index.js") ||
        candidate === path.join(process.cwd(), "openclaw.mjs"),
    );
    const managedState = profileStateDir("work");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: managedState });
    primeServiceCommand(["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: "19222",
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    mockGatewayHealth(VERSION, "updated-gateway");

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
        await updateCommand({});
        expect(process.env.OPENCLAW_PROFILE).toBe("personal");
      },
    );

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toHaveLength(1);
    expect(freshRestartCalls()[0]?.[1]).toMatchObject({ env: { OPENCLAW_PROFILE: "work" } });
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(completionCommandCall()?.[1]).toMatchObject({ env: { OPENCLAW_PROFILE: "personal" } });
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

  it("stops a post-core process with open handles only once when result reads overlap", async () => {
    setupUpdatedRootRefresh();
    const kill = vi.fn();
    let resultPath: string | undefined;
    const readsReady = createDeferred();
    const releaseReads = createDeferred();
    const jsonFiles = await import("../infra/json-files.js");
    const readJsonIfExists = jsonFiles.readJsonIfExists;
    const pendingReads: Promise<unknown>[] = [];
    let resultReads = 0;
    const readSpy = vi
      .spyOn(jsonFiles, "readJsonIfExists")
      .mockImplementation(<T>(...args: Parameters<typeof readJsonIfExists>) => {
        const read = readJsonIfExists<T>(...args).then(async (result) => {
          if (args[0] === resultPath) {
            if (++resultReads === 2) {
              readsReady.resolve();
            }
            await releaseReads.promise;
          }
          return result;
        });
        pendingReads.push(read);
        return read;
      });
    spawn.mockImplementationOnce((_command: unknown, _argv: unknown, options: unknown) => {
      resultPath = (options as { env?: NodeJS.ProcessEnv }).env
        ?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
      if (!resultPath) {
        throw new Error("missing post-core result path");
      }
      fsSync.writeFileSync(resultPath, `${JSON.stringify({ status: "ok" })}\n`, "utf-8");
      const child = new EventEmitter() as EventEmitter & {
        kill: typeof kill;
        once: EventEmitter["once"];
      };
      child.kill = kill.mockImplementation(() => {
        queueMicrotask(() => {
          child.emit("exit", null, "SIGTERM");
          child.emit("close", null, "SIGTERM");
        });
        return true;
      });
      return child;
    });

    const updating = updateCommand({ yes: true, restart: false });
    try {
      await Promise.race([
        readsReady.promise,
        updating.then(() => {
          throw new Error("update finished before overlapping result reads");
        }),
      ]);
      releaseReads.resolve();
      await updating;
      await Promise.all(pendingReads);

      expect(kill).toHaveBeenCalledTimes(1);
      expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    } finally {
      releaseReads.resolve();
      await Promise.allSettled([updating, ...pendingReads]);
      readSpy.mockRestore();
    }
  });
});
