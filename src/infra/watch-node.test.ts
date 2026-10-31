import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord, bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import {
  runWatch,
  watchReady,
  type WatchFixture as WatchRunParams,
} from "../../test/scripts/watch-node.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

const VOICE_CALL_README = bundledPluginFile("voice-call", "README.md");
const VOICE_CALL_MANIFEST = bundledPluginFile("voice-call", "openclaw.plugin.json");
const VOICE_CALL_PACKAGE = bundledPluginFile("voice-call", "package.json");

function observe(
  watcher: EventEmitter & { close(): Promise<void> },
  options: Parameters<NonNullable<WatchRunParams["createWatcher"]>>[1],
) {
  watcher.on("change", options.onChange);
  watcher.on("add", options.onChange);
  watcher.on("unlink", options.onChange);
  watcher.on("error", options.onError);
  return watcher;
}
const resolveTestWatchLockPath = (cwd: string, args: string[]) =>
  path.join(
    cwd,
    ".local",
    "watch-node",
    `${createHash("sha256").update(cwd).update("\0").update(args.join("\0")).digest("hex").slice(0, 12)}.json`,
  );

const createFakeProcess = () =>
  Object.assign(new EventEmitter(), {
    pid: 4242,
    execPath: "/usr/local/bin/node",
  }) as unknown as NodeJS.Process;
const createChild = () => Object.assign(new EventEmitter(), { kill: vi.fn() });
const spawnChildren = (...children: ReturnType<typeof createChild>[]) => {
  const spawn = vi.fn();
  for (const child of children) {
    spawn.mockReturnValueOnce(child);
  }
  return spawn;
};
function createWatcherHarness() {
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
  const createWatcher = vi.fn((_paths: string[], options: Parameters<typeof observe>[1]) =>
    observe(watcher, options),
  );
  return { watcher, createWatcher, fakeProcess: createFakeProcess() };
}

const createKillableChild = (exitCode = 143) => {
  const child = createChild();
  child.kill.mockImplementation((signal: NodeJS.Signals = "SIGTERM") => {
    // A native run-node owner that completes requested cleanup acknowledges
    // SIGTERM with a code. Raw signal death is covered independently below.
    queueMicrotask(() =>
      signal === "SIGTERM" ? child.emit("exit", exitCode, null) : child.emit("exit", null, signal),
    );
    return true;
  });
  return child;
};

const createWatchHarness = (children = [createKillableChild()], platform?: NodeJS.Platform) => {
  const h = createWatcherHarness();
  if (platform) {
    Object.assign(h.fakeProcess, { platform });
  }
  const spawn = children.length === 1 ? vi.fn(() => children[0]) : spawnChildren(...children);
  return {
    ...h,
    child: children[0]!,
    spawn,
    run: (options: Partial<WatchRunParams> = {}) =>
      runWatch({
        args: ["gateway", "--force"],
        createWatcher: h.createWatcher,
        process: h.fakeProcess,
        spawn,
        ...options,
      }),
  };
};

const startWatchRun = async ({
  args = ["gateway", "--force"],
  env,
  spawn,
  ...overrides
}: Pick<WatchRunParams, "args" | "env" | "fs" | "pathClassifier" | "sleep"> & {
  spawn: NonNullable<WatchRunParams["spawn"]>;
}) => {
  const harness = createWatchHarness();
  const runPromise = harness.run({
    args,
    env,
    fs: { existsSync: () => true },
    spawn,
    ...overrides,
  });
  await watchReady();
  return { ...harness, runPromise };
};

async function stopWatch(fakeProcess: NodeJS.Process, run: Promise<unknown>) {
  fakeProcess.emit("SIGINT");
  expect(await run).toBe(130);
}

function deferredBuild() {
  let ready = false;
  const polls: Array<() => void> = [];
  const sleep = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        polls.push(resolve);
      }),
  );
  return {
    options: { fs: { existsSync: () => ready }, sleep },
    restore() {
      ready = true;
      for (const resume of polls) {
        resume();
      }
    },
  };
}

const requireRecord = createRequireRecord("object", "expected-label-object");

function requireMockCall(mock: ReturnType<typeof vi.fn>, callIndex: number): unknown[] {
  return expectDefined(mock.mock.calls[callIndex], `expected mock call ${callIndex}`);
}

function requireSpawnOptions(spawn: ReturnType<typeof vi.fn>, callIndex: number) {
  return requireRecord(requireMockCall(spawn, callIndex)[2], "spawn options");
}

it.each(["resolve", "reject"] as const)(
  "holds the watch lock through close %s",
  async (outcome) => {
    await withTestDir({ prefix: "openclaw-watch-close-" }, async (cwd) => {
      const closing = createDeferredCore();
      const child = createKillableChild();
      const spawn = vi.fn(() => child);
      const fakeProcess = createFakeProcess();
      const watcher = Object.assign(new EventEmitter(), {
        close: vi.fn(() => closing.promise),
      });
      const args = ["status"];
      const lockPath = resolveTestWatchLockPath(cwd, args);
      const run = runWatch({
        args,
        cwd,
        process: fakeProcess,
        spawn,
        pathClassifier: {
          refreshGeneratedPluginAssetPaths() {},
          isRestartRelevantRunNodePath: () => true,
        },
        createWatcher: (_paths, options) => {
          return observe(watcher, options);
        },
      });
      await watchReady();
      const failure = new Error("physical watcher close failed");
      const completion =
        outcome === "reject" ? expect(run).rejects.toBe(failure) : expect(run).resolves.toBe(0);
      try {
        child.emit("exit", 0, null);
        expect(watcher.close).toHaveBeenCalledOnce();
        expect(fs.existsSync(lockPath)).toBe(true);
        // Delivery already queued by the retiring backend cannot restart a child.
        watcher.emit("change", "src/index.ts");
        expect(spawn).toHaveBeenCalledOnce();
      } finally {
        if (outcome === "reject") {
          closing.reject(failure);
        } else {
          closing.resolve();
        }
        await completion;
      }
      expect(fs.existsSync(lockPath)).toBe(outcome === "reject");
    });
  },
);

it("preserves unrequested Unix SIGTERM", async () => {
  const { child, spawn, fakeProcess, run: launch } = createWatchHarness([createChild()], "linux");
  const run = launch({
    args: ["gateway"],
    env: {},
    createWatcher: () => ({ on: () => {}, close: async () => {} }),
  });
  await watchReady();
  child.emit("exit", null, "SIGTERM");
  await expect(run).resolves.toBe("SIGTERM");
  expect(spawn).toHaveBeenCalledOnce();
  expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
});

it.each(["restart", "shutdown", "doctor", "startup-error"] as const)(
  "preserves Unix signal loss during %s",
  async (phase) => {
    const child = createChild();
    const doctor = createChild();
    const {
      spawn,
      watcher,
      fakeProcess,
      run: launch,
    } = createWatchHarness([child, doctor], "linux");
    const startupError = new Error("watcher dependency failed");
    const run = launch({
      args: ["gateway"],
      env: {},
      fs: { existsSync: () => true },
      ...(phase === "startup-error"
        ? {
            loadWatcher: async () => {
              throw startupError;
            },
          }
        : {}),
    });
    await watchReady();
    if (phase === "restart") {
      watcher.emit("change", "src/index.ts");
    } else if (phase === "shutdown") {
      fakeProcess.emit("SIGTERM");
    } else if (phase === "doctor") {
      child.emit("exit", 1, null);
    } else {
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    }
    (phase === "doctor" ? doctor : child).emit("exit", null, "SIGKILL");
    await expect(run).resolves.toBe("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(phase === "doctor" ? 2 : 1);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  },
);

it("rebuilds and shuts down with Windows SIGTERM", async () => {
  const first = createChild();
  const second = createChild();
  const { spawn, watcher, fakeProcess, run: launch } = createWatchHarness([first, second], "win32");
  const run = launch({
    args: ["gateway"],
    env: {},
    fs: { existsSync: () => true },
  });
  await watchReady();
  watcher.emit("change", "src/index.ts");
  expect(first.kill).toHaveBeenCalledWith("SIGTERM");
  first.emit("exit", null, "SIGTERM");
  expect(spawn).toHaveBeenCalledTimes(2);
  fakeProcess.emit("SIGTERM");
  second.emit("exit", null, "SIGTERM");
  await expect(run).resolves.toBe(143);
  expect(second.kill).toHaveBeenCalledWith("SIGTERM");
});

it("starts the runner before loading fs-safe", async () => {
  const { child, spawn, watcher, createWatcher: watch, fakeProcess, run } = createWatchHarness();
  const loading = createDeferredCore<typeof watch>();
  const loadWatcher = vi.fn(() => loading.promise);
  const runPromise = run({
    env: { LAUNCH_JOB_LABEL: "ai.openclaw.gateway" },
    loadWatcher,
  });
  await watchReady();
  expect(spawn).toHaveBeenCalledTimes(1);
  const spawnEnv = requireRecord(requireSpawnOptions(spawn, 0).env, "spawn env");
  expect(spawnEnv).toMatchObject({
    LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
    OPENCLAW_NO_RESPAWN: "1",
  });
  expect(spawnEnv.OPENCLAW_TRACE_SYNC_IO).toBeUndefined();
  expect(loadWatcher).toHaveBeenCalledTimes(1);
  expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(
    expectDefined(loadWatcher.mock.invocationCallOrder[0], "loader call"),
  );
  loading.resolve(watch);
  await nextTurn();
  expect(watch).toHaveBeenCalledTimes(1);
  await stopWatch(fakeProcess, runPromise);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(watcher.close).toHaveBeenCalledTimes(1);
});

it("refreshes generated assets before each start", async () => {
  const childA = createKillableChild(0);
  const childB = createKillableChild();
  const spawn = spawnChildren(childA, childB);
  const pathClassifier = {
    refreshGeneratedPluginAssetPaths: vi.fn(),
    isRestartRelevantRunNodePath: vi.fn(() => true),
  };
  const { watcher, fakeProcess, runPromise } = await startWatchRun({
    pathClassifier,
    spawn,
  });
  expect(pathClassifier.refreshGeneratedPluginAssetPaths).toHaveBeenCalledTimes(1);
  watcher.emit("change", "extensions/browser/package.json");
  await nextTurn();
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(pathClassifier.refreshGeneratedPluginAssetPaths).toHaveBeenCalledTimes(2);
  await stopWatch(fakeProcess, runPromise);
});

it("repairs a failed Gateway with Doctor and restarts", async () => {
  const gatewayA = createChild();
  const doctor = createChild();
  const gatewayB = createKillableChild();
  const spawn = spawnChildren(gatewayA, doctor, gatewayB);
  const { watcher, fakeProcess, runPromise } = await startWatchRun({ env: {}, spawn });
  gatewayA.emit("exit", 1, null);
  await nextTurn();
  expect(spawn).toHaveBeenCalledTimes(2);
  const doctorSpawnCall = requireMockCall(spawn, 1);
  expect(doctorSpawnCall[0]).toBe("/usr/local/bin/node");
  expect(doctorSpawnCall[1]).toEqual([
    "scripts/run-node.mjs",
    "doctor",
    "--fix",
    "--non-interactive",
  ]);
  expect(requireSpawnOptions(spawn, 1).stdio).toBe("inherit");
  doctor.emit("exit", 0, null);
  await nextTurn();
  expect(spawn).toHaveBeenCalledTimes(3);
  const restartedGatewaySpawnCall = requireMockCall(spawn, 2);
  expect(restartedGatewaySpawnCall[0]).toBe("/usr/local/bin/node");
  expect(restartedGatewaySpawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
  expect(requireSpawnOptions(spawn, 2).stdio).toBe("inherit");
  await stopWatch(fakeProcess, runPromise);
  expect(gatewayB.kill).toHaveBeenCalledWith("SIGTERM");
  expect(watcher.close).toHaveBeenCalledTimes(1);
});

it("honors disabled auto Doctor", async () => {
  const { child, spawn, watcher, run } = createWatchHarness();
  const runPromise = run({
    env: { OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "0" },
  });
  await watchReady();
  child.emit("exit", 1, null);
  expect(await runPromise).toBe(1);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(watcher.close).toHaveBeenCalledTimes(1);
});

it("restarts on unexpected exit code 143", async () => {
  const childA = createChild();
  const childB = createKillableChild();
  const spawn = spawnChildren(childA, childB);
  const { watcher, fakeProcess, runPromise } = await startWatchRun({ spawn });
  childA.emit("exit", 143, null);
  await nextTurn();
  expect(spawn).toHaveBeenCalledTimes(2);
  await stopWatch(fakeProcess, runPromise);
  expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
  expect(watcher.close).toHaveBeenCalledTimes(1);
});

it("filters edits before restarting", async () => {
  const childA = createKillableChild(0);
  const childB = createKillableChild(0);
  const childC = createKillableChild(0);
  const childD = createKillableChild();
  const spawn = spawnChildren(childA, childB, childC, childD);
  const { watcher, fakeProcess, runPromise } = await startWatchRun({ spawn });
  for (const file of [
    "src/infra/watch-node.test.ts",
    "src/infra/watch-node.test.tsx",
    "src/infra/watch-node-test-helpers.ts",
    VOICE_CALL_README,
  ]) {
    watcher.emit("change", file);
    await nextTurn();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();
  }
  for (const [index, [file, child]] of (
    [
      [VOICE_CALL_MANIFEST, childA],
      [VOICE_CALL_PACKAGE, childB],
      ["src/infra/watch-node.ts", childC],
    ] as const
  ).entries()) {
    watcher.emit("change", file);
    await nextTurn();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(index + 2);
  }
  await stopWatch(fakeProcess, runPromise);
});

it("keeps the healthy child alive during rebuild", async () => {
  const childA = createKillableChild();
  const childB = createKillableChild();
  const spawn = spawnChildren(childA, childB);
  const build = deferredBuild();
  const { watcher, fakeProcess, runPromise } = await startWatchRun({ ...build.options, spawn });
  watcher.emit("change", "src/infra/restart.ts");
  watcher.emit("change", "src/infra/restart.ts");
  expect(childA.kill).not.toHaveBeenCalled();
  expect(build.options.sleep).toHaveBeenCalledTimes(1);
  build.restore();
  await nextTurn();
  expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
  expect(spawn).toHaveBeenCalledTimes(2);
  await stopWatch(fakeProcess, runPromise);
});

it("does not resurrect a child after shutdown", async () => {
  const child = createKillableChild();
  const spawn = vi.fn(() => child);
  const build = deferredBuild();
  const { watcher, fakeProcess, runPromise } = await startWatchRun({ ...build.options, spawn });
  watcher.emit("change", "src/infra/restart.ts");
  await stopWatch(fakeProcess, runPromise);
  build.restore();
  await nextTurn();
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("waits for the build when a deferred child exits", async () => {
  const childA = createChild();
  const childB = createKillableChild();
  const spawn = spawnChildren(childA, childB);
  const build = deferredBuild();
  const { watcher, fakeProcess, runPromise } = await startWatchRun({ ...build.options, spawn });
  watcher.emit("change", "src/infra/restart.ts");
  childA.emit("exit", 1, null);
  watcher.emit("change", "src/infra/restart.ts");
  expect(spawn).toHaveBeenCalledTimes(1);
  build.restore();
  await nextTurn();
  expect(spawn).toHaveBeenCalledTimes(2);
  await stopWatch(fakeProcess, runPromise);
});

it.for([0, 9_000])("replaces the prior lock holder after its %dms drain", async (drainMs) => {
  const { child, spawn, watcher, fakeProcess, run } = createWatchHarness();
  await withTestDir({ prefix: "openclaw-watch-node-lock-" }, async (cwd) => {
    const lockPath = resolveTestWatchLockPath(cwd, ["gateway", "--force"]);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 2121,
        command: "gateway --force",
        createdAt: new Date(1_700_000_000_000).toISOString(),
        cwd,
        watchSession: "existing-session",
      })}\n`,
      "utf8",
    );
    let existingWatcherAlive = true;
    let elapsedMs = 0;
    const signalProcess = vi.fn<NonNullable<WatchRunParams["signalProcess"]>>((pid, signal) => {
      if (signal === 0) {
        if (pid === 2121 && existingWatcherAlive) {
          return;
        }
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (pid === 2121 && signal === "SIGTERM") {
        existingWatcherAlive = drainMs > 0;
        return;
      }
      throw new Error(`unexpected signal ${signal} for pid ${pid}`);
    });
    const runPromise = run({
      cwd,
      now: () => 1_700_000_000_000 + elapsedMs,
      signalProcess,
      sleep: async (ms) => {
        elapsedMs += ms;
        if (elapsedMs >= drainMs) {
          existingWatcherAlive = false;
        }
      },
    });
    await watchReady();
    await nextTurn();
    expect(signalProcess).toHaveBeenCalledWith(2121, "SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(1);
    const lockRecord = requireRecord(JSON.parse(fs.readFileSync(lockPath, "utf8")), "watch lock");
    expect(lockRecord).toMatchObject({
      pid: 4242,
      command: "gateway --force",
      watchSession: "1700000000000-4242",
    });
    await stopWatch(fakeProcess, runPromise);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });
});
