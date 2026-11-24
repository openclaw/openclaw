import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as checks from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import { withUpdateCommandExecutor } from "./update-cli/update-command-executor.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

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
