import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as configIo from "../config/io.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { VERSION } from "../version.js";
import * as checks from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import { createChangedPostCoreUpdateOptions } from "./update-cli/update-cli-config.test-support.js";
import {
  writeGitUpdateResultFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const nodeExecutable = resolveTestNodeExecPath();
const f = createUpdateCliFixture();

const profileEnv = (profile: string, state: string, port: string) => ({
  OPENCLAW_PROFILE: profile,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_GATEWAY_PORT: port,
});
function closeChild(child: EventEmitter, code: number | null = 0, signal: string | null = null) {
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}
function exitingChild(code = 0) {
  const child = new EventEmitter();
  queueMicrotask(() => closeChild(child, code));
  return child;
}
function commitResult(env: NodeJS.ProcessEnv, result: unknown) {
  const file = checks.requireValue(env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, "child result");
  fsSync.writeFileSync(file, JSON.stringify(result));
  return file;
}
const readJson = (file: string) => JSON.parse(fsSync.readFileSync(file, "utf8"));
function freshContinuation() {
  vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
    f.FRESH_POST_UPDATE_ENTRYPOINT,
  );
  mocks.readPackageVersion.mockResolvedValueOnce(null);
}
function profileState(profile: string) {
  const state = f.profileStateDir(profile);
  f.initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: state });
  return state;
}
const untilSignal = (signal: Promise<unknown>, updating: Promise<unknown>, message: string) =>
  Promise.race([
    signal,
    updating.then(() => {
      throw new Error(message);
    }),
  ]);

const continueFreshPostCore = () =>
  cli.continuePostCoreUpdateInFreshProcess({
    root: "/tmp/openclaw-updated-root",
    channel: "stable",
    requestedChannel: null,
    opts: {},
    pluginInstallRecords: {},
    updateStartedAtMs: 123,
    timeoutMs: 30_000,
  });

it("keeps stopped owned-service config and plugin state through fresh post-core handoff", async () => {
  const updatedEntrypoint = await f.setupManagedGitRootRefresh(true);
  const managedState = profileState("work");
  const personalState = profileState("personal");
  const managedConfig = { ...f.baseConfig, update: { channel: "beta" as const } };
  const managedSnapshot = f.configSnapshot(managedConfig, {
    path: path.join(managedState, "openclaw.json"),
  });
  const managedRecords = {
    telegram: { source: "npm", spec: "@openclaw/telegram@beta" },
  } satisfies Record<string, PluginInstallRecord>;
  f.primeServiceCommand(
    [nodeExecutable, path.join(process.cwd(), "dist", "index.js"), "gateway", "run"],
    {
      ...profileEnv("work", managedState, "19222"),
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(mocks.unrelatedGatewayFixturePid),
    },
  );
  const snapshotForEnv = (env: NodeJS.ProcessEnv = process.env) =>
    env.OPENCLAW_PROFILE === "work" ? managedSnapshot : f.baseSnapshot;
  vi.mocked(cli.readConfigFileSnapshot).mockImplementation(async () => snapshotForEnv());
  const createConfigIO = configIo.createConfigIO;
  vi.spyOn(configIo, "createConfigIO").mockImplementation((options) => ({
    ...createConfigIO(options),
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: snapshotForEnv(options?.env),
      writeOptions: {},
    }),
  }));
  mocks.loadInstalledPluginIndexInstallRecords.mockImplementation(async (options = {}) =>
    options.env?.OPENCLAW_PROFILE === "work" ? managedRecords : {},
  );
  let handedConfig: unknown;
  let handedRecords: unknown;
  mocks.spawn.mockImplementationOnce((_node, _argv, options) => {
    const env = (options as { env?: NodeJS.ProcessEnv }).env;
    handedConfig = readJson(env?.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH ?? "");
    handedRecords = readJson(env?.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH ?? "");
    return exitingChild();
  });

  await withEnvAsync(profileEnv("personal", personalState, "19111"), async () => {
    await cli.updateCommand({ yes: true, timeout: "1800" });
    expect(process.env.OPENCLAW_PROFILE).toBe("personal");
  });

  const handoff = checks.spawnCall();
  const handoffEnv = checks.requireValue(handoff?.[2]?.env, "post-core environment");
  expect(
    cli.getUpdateRun(checks.requireValue(handoffEnv.OPENCLAW_UPDATE_RUN_ID, "update run id"), {
      env: handoffEnv,
    })?.trigger,
  ).toBe("cli");
  expect(handoff?.[0]).toBe(process.execPath);
  expect(handoff?.[1]).toEqual([updatedEntrypoint, "update", "--yes", "--timeout", "1800"]);
  expect(handoff?.[2]).toMatchObject({
    stdio: "inherit",
    env: {
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_POST_CORE: "1",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
      ...profileEnv("work", managedState, "19222"),
    },
  });
  expect(cli.doctorCommand).not.toHaveBeenCalled();
  expect(checks.completionCommandCall()?.[1]).toMatchObject({
    env: { OPENCLAW_PROFILE: "personal" },
  });
  expect(mocks.serviceStop).toHaveBeenCalledOnce();
  expect(checks.gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
  expect(checks.freshRestartCalls()).toHaveLength(1);
  expect(checks.getLogOutput()).toContain("Gateway: restarted and verified.");
  expect([handoffEnv.OPENCLAW_SERVICE_MARKER, handoffEnv[GATEWAY_SERVICE_RUNTIME_PID_ENV]]).toEqual(
    [undefined, undefined],
  );
  expect(handedConfig).toEqual({ sourceConfig: managedConfig, authoredConfig: managedConfig });
  expect(handedRecords).toEqual(managedRecords);
  const restartIndex = checks
    .commandCalls()
    .findIndex(([argv]) => argv[2] === "gateway" && argv[3] === "restart");
  expect(
    vi.mocked(cli.runCommandWithTimeout).mock.invocationCallOrder[restartIndex],
  ).toBeGreaterThan(
    checks.requireValue(mocks.spawn.mock.invocationCallOrder[0], "post-core handoff"),
  );
});

it("keeps foreign-service updates in the caller profile", async () => {
  const personalState = profileState("personal");
  const { root, entrypoints } = f.setupUpdatedRootRefresh();
  const foreignRoot = f.tempDirs.make("openclaw-update-foreign-profile-");
  const foreignEntrypoint = await writeOpenClawPackageFixture(foreignRoot, "2026.4.21", {
    entrySource: "export {};\n",
  });
  cli.mockGitUpdateAfterMutation(
    await writeGitUpdateResultFixture({
      root,
      before: { sha: "old-caller-sha", version: "2026.4.26" },
      after: { sha: "new-caller-sha", version: VERSION },
    }),
  );
  mocks.serviceReadCommand.mockResolvedValue({
    programArguments: [nodeExecutable, foreignEntrypoint, "gateway", "run"],
    environment: {
      OPENCLAW_PROFILE: "foreign",
      OPENCLAW_STATE_DIR: f.profileStateDir("foreign"),
      OPENCLAW_GATEWAY_PORT: "19333",
    },
  });
  mocks.serviceLoaded.mockResolvedValue(true);
  mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
  mocks.pathExists.mockImplementation(
    async (candidate: string) =>
      entrypoints.includes(candidate) || candidate.endsWith("package.json"),
  );
  profileState("work");
  const callerEnv = {
    OPENCLAW_PROFILE: "personal",
    OPENCLAW_STATE_DIR: personalState,
    OPENCLAW_GATEWAY_PORT: "19111",
  };
  await withEnvAsync(callerEnv, () => cli.updateCommand({ yes: true }));

  checks.expectNoSideEffects(mocks.serviceStop, mocks.serviceRestart);
  expect(checks.spawnCall()?.[2]?.env).toMatchObject(callerEnv);
});

it("never pipes JSON post-core output to stdout", async () => {
  const { entrypoints } = f.setupUpdatedRootRefresh();
  const stdout = vi.fn();
  const stderr = vi.fn();
  mocks.spawn.mockImplementationOnce(() =>
    Object.assign(exitingChild(), { stdout: { pipe: stdout }, stderr: { pipe: stderr } }),
  );
  await cli.updateCommand({ json: true, restart: false });
  const call = checks.spawnCall();
  expect(call?.[1]).toEqual([
    entrypoints[0],
    "update",
    "--json",
    "--no-restart",
    "--timeout",
    "1800",
  ]);
  expect(call?.[2]?.stdio).toBe("pipe");
  expect([stdout.mock.calls, stderr.mock.calls]).toEqual([[[process.stderr]], [[process.stderr]]]);
});

it("keeps the candidate stopped through plugin convergence and only restarts the verified previous version despite its plugin errors", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  mocks.suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
  mocks.resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
  const root = await f.mockPackageInstallAtCaseDir();
  const entryPath = path.join(root, "dist", "index.js");
  vi.mocked(cli.resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(entryPath);
  mocks.serviceLoaded.mockResolvedValue(true);
  f.primeServiceCommand(
    [nodeExecutable, entryPath, "gateway", "run"],
    undefined,
    resolveGatewayTaskScriptPath(process.env),
  );
  mocks.pathExists.mockImplementation(async (candidate: string) => candidate === entryPath);
  mocks.callGateway.mockImplementation(
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
  const runFixtureCommand = checks.requireValue(
    vi.mocked(cli.runCommandWithTimeout).getMockImplementation(),
    "staged package commands",
  );
  vi.mocked(cli.runCommandWithTimeout).mockImplementation(async (argv, options) => {
    if (argv[2] === "gateway" && ["install", "restart"].includes(argv[3] ?? "")) {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      activations.push({
        version: manifest.version,
        afterPlugin: mocks.spawn.mock.calls.length > 0,
      });
    }
    return runFixtureCommand(argv, options);
  });
  mocks.spawn.mockImplementationOnce((_command: unknown, _argv: unknown, options: unknown) => {
    const resultPath = (options as { env?: NodeJS.ProcessEnv }).env
      ?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
    if (!resultPath) {
      throw new Error("missing post-core result path");
    }
    queueMicrotask(() => {
      void fs.writeFile(
        resultPath,
        JSON.stringify({
          ...createChangedPostCoreUpdateOptions().pluginUpdate,
          status: "error",
          changed: false,
          npm: {
            changed: false,
            outcomes: [
              { pluginId: "demo", status: "error", message: "Plugin extension entry missing" },
            ],
          },
        }),
        "utf-8",
      );
    });
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {
        queueMicrotask(() => closeChild(child, null, "SIGTERM"));
        return true;
      }),
    });
    return child;
  });

  await expect(cli.updateCommand({ yes: true })).rejects.toEqual(new cli.ExitError(1));

  expect(mocks.serviceStop).toHaveBeenCalled();
  checks.expectNoSideEffects(mocks.serviceRestart, cli.runDaemonRestart);
  expect(cli.defaultRuntime.exit).not.toHaveBeenCalled();
  expect(checks.getLogOutput()).not.toContain("Update Result: OK");
  expect(mocks.spawn).toHaveBeenCalled();
  expect(mocks.resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
  const pluginStartOrder = checks.requireValue(
    mocks.spawn.mock.invocationCallOrder[0],
    "plugin child start",
  );
  expect(activations).toEqual([{ version: "1.0.0", afterPlugin: true }]);
  expect(checks.gatewayCommandCall(entryPath, "install")).toBeUndefined();
  expect(checks.gatewayCommandCall(entryPath, "restart")?.[0]).toContain("--preserve-definition");
  expect(mocks.resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(
    pluginStartOrder,
  );
});

it.each(["spawn", "phase"])(
  "restores the exact plugin index revision when post-core %s fails",
  async (failureKind) => {
    const root = f.createCaseDir("openclaw-post-core-index");
    vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(root, "dist/entry.js"),
    );
    mocks.readPackageVersion.mockResolvedValue("2026.4.29");
    const previousPersistedIndex = {
      policyHash: "previous-policy",
      installRecords: {
        msteams: { source: "npm", spec: "@openclaw/msteams", resolvedVersion: "2026.5.28" },
      } satisfies Record<string, PluginInstallRecord>,
    };
    mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: previousPersistedIndex as never,
      revision: 17,
    });
    mocks.spawn.mockImplementationOnce((_node, _argv, options) => {
      if (failureKind === "spawn") {
        throw new Error("post-core spawn failed");
      }
      commitResult(options.env, {
        status: "failed",
        error: "pre-plugin Doctor failed before convergence",
      });
      return exitingChild(1);
    });

    const updating = cli.continuePostCoreUpdateInFreshProcess({
      root,
      channel: "stable",
      requestedChannel: null,
      opts: { yes: true, restart: false },
      pluginInstallRecords: previousPersistedIndex.installRecords,
      updateStartedAtMs: Date.now(),
      timeoutMs: 30_000,
    });
    if (failureKind === "spawn") {
      await expect(updating).rejects.toThrow("post-core spawn failed");
    } else {
      await expect(updating).resolves.toEqual({
        resumed: false,
        exitCode: 1,
        error: "pre-plugin Doctor failed before convergence",
      });
    }
    expect(cli.defaultRuntime.exit).not.toHaveBeenCalled();

    expect(mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
      previousPersistedIndex,
      17,
      { lease: expect.anything() },
    );
  },
);

it("joins Windows taskkill after the committed post-core child closes", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  freshContinuation();
  const helperStarted = createDeferred();
  const releaseHelper = createDeferred();
  let helperSettled = false;
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
  mocks.spawn.mockImplementationOnce((_node, _args, options) => {
    commitResult(options.env, { status: "ok" });
    return child;
  });
  vi.mocked(cli.runExec).mockImplementationOnce(async (command, args) => {
    expect(command).toMatch(/taskkill\.exe$/);
    expect(args).toEqual(["/PID", "4242", "/T", "/F"]);
    closeChild(child, null, "SIGTERM");
    helperStarted.resolve();
    await releaseHelper.promise;
    helperSettled = true;
    return { stdout: "", stderr: "" };
  });
  const updating = continueFreshPostCore();
  const settled = vi.fn();
  void updating.then(settled, settled);
  try {
    await untilSignal(
      helperStarted.promise,
      updating,
      "post-core returned before stopping its child",
    );
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
  }
});

it.each(["overlapping-reads", "close-before-read", "termination-error"] as const)(
  "preserves a committed post-core result after writer settlement (%s)",
  async (race) => {
    const overlapping = race === "overlapping-reads";
    if (overlapping) {
      f.setupUpdatedRootRefresh();
    } else {
      freshContinuation();
    }
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const reading = createDeferred();
    const releaseRead = createDeferred();
    let resultPath: string | undefined;
    let resultReads = 0;
    const jsonFiles = await import("../infra/json-files.js");
    const read = jsonFiles.readJsonIfExists;
    const pendingReads: Promise<unknown>[] = [];
    vi.spyOn(jsonFiles, "readJsonIfExists").mockImplementation(
      <T>(...args: Parameters<typeof read>) => {
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
      },
    );
    mocks.spawn.mockImplementationOnce((_node, _args, options) => {
      resultPath = commitResult(options.env, { status: "ok" });
      if (race !== "close-before-read") {
        child.kill.mockImplementation(() => {
          queueMicrotask(() => {
            closeChild(child, overlapping ? null : 0, overlapping ? "SIGTERM" : null);
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
      ? cli.updateCommand({ yes: true, restart: false })
      : continueFreshPostCore();
    const outcome = updating.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      if (race !== "termination-error") {
        await untilSignal(reading.promise, updating, "update finished before held result reads");
        if (!overlapping) {
          closeChild(child, null, "SIGTERM");
        }
        releaseRead.resolve();
      }
      if (overlapping) {
        await updating;
        await Promise.all(pendingReads);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
        expect(cli.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
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
    }
  },
);
