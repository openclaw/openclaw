import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import * as checks from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import { createChangedPostCoreUpdateOptions } from "./update-cli/update-cli-config.test-support.js";
import { withUpdateCommandExecutor } from "./update-cli/update-command-executor.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const nodeExecutable = resolveTestNodeExecPath();
// These handoffs target the current runtime; omitted engines model a legacy target.
const databaseEngines = ["sqlite", "postgres"];
const f = createUpdateCliFixture({ databaseEngines });

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
function freshContinuation() {
  vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
    f.FRESH_POST_UPDATE_ENTRYPOINT,
  );
  mocks.readPackageVersion.mockResolvedValueOnce(null);
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

it.each([true, false])(
  "copies the originals once the fresh post-core process will launch (launches=%s)",
  async (launches) => {
    // The fresh process runs Doctor repair and cannot copy itself; a missing entry point
    // launches nothing and changes nothing, so it copies nothing.
    const order: string[] = [];
    const captureOriginal = vi.fn(async () => {
      order.push("copy");
    });
    if (launches) {
      freshContinuation();
      mocks.spawn.mockImplementationOnce(() => {
        order.push("spawn");
        return exitingChild();
      });
    } else {
      vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(undefined);
    }
    const root = "/tmp/openclaw-updated-root";
    const { runId } = cli.createUpdateRun({ trigger: "cli" });
    const result = await withUpdateCommandExecutor(runId, async (executor) => {
      const executorFence = await executor.enter(root);
      return await cli.continuePostCoreUpdateInFreshProcess({
        root,
        channel: "stable",
        requestedChannel: null,
        opts: { run: { runId, env: process.env, executorFence, captureOriginal } },
        pluginInstallRecords: {},
        updateStartedAtMs: 123,
        timeoutMs: 30_000,
      });
    });
    expect(order).toEqual(launches ? ["copy", "spawn"] : []);
    if (!launches) {
      expect(result).toEqual({ resumed: false });
    }
  },
);

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

it.each(["close-before-read", "termination-error"] as const)(
  "preserves a committed post-core result after writer settlement (%s)",
  async (race) => {
    freshContinuation();
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
            if (++resultReads === 1) {
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
            closeChild(child);
          });
          if (race === "termination-error") {
            throw new Error("signal delivery failed after result commit");
          }
          return true;
        });
      }
      return child;
    });
    const updating = continueFreshPostCore();
    const outcome = updating.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      if (race !== "termination-error") {
        await untilSignal(reading.promise, updating, "update finished before held result reads");
        closeChild(child, null, "SIGTERM");
        releaseRead.resolve();
      }
      expect(await outcome).toEqual({
        result: { resumed: true, pluginUpdate: { status: "ok" } },
      });
      if (race === "close-before-read") {
        expect(child.kill).not.toHaveBeenCalled();
      }
    } finally {
      releaseRead.resolve();
      await Promise.allSettled([updating, ...pendingReads]);
    }
  },
);
