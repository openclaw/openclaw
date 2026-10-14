// Tests watched node process restart and hashing behavior.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord, bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
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

const createKillableChild = () => {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
  });
  child.kill.mockImplementation((signal: NodeJS.Signals = "SIGTERM") => {
    // A native run-node owner that completes requested cleanup acknowledges
    // SIGTERM with a code. Raw signal death is covered independently below.
    queueMicrotask(() =>
      signal === "SIGTERM" ? child.emit("exit", 143, null) : child.emit("exit", null, signal),
    );
    return true;
  });
  return child;
};

const createWatchHarness = () => {
  const child = createKillableChild();
  const spawn = vi.fn(() => child);
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
  });
  const createWatcher = vi.fn((_paths: string[], options: Parameters<typeof observe>[1]) =>
    observe(watcher, options),
  );
  const fakeProcess = createFakeProcess();
  return { child, spawn, watcher, createWatcher, fakeProcess };
};

const createAutoExitChild = () => {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
  });
  child.kill.mockImplementation(() => {
    queueMicrotask(() => child.emit("exit", 0, null));
  });
  return child;
};

const startWatchRun = async ({
  args = ["gateway", "--force"],
  env,
  spawn,
}: {
  args?: string[];
  env?: WatchRunParams["env"];
  spawn: NonNullable<WatchRunParams["spawn"]>;
}) => {
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
  });
  const createWatcher = vi.fn((_paths: string[], options: Parameters<typeof observe>[1]) =>
    observe(watcher, options),
  );
  const fakeProcess = createFakeProcess();
  const runPromise = runWatch({
    args,
    createWatcher,
    env,
    fs: { existsSync: () => true },
    process: fakeProcess,
    spawn,
  });
  await watchReady();
  return { watcher, createWatcher, fakeProcess, runPromise };
};

const requireRecord = createRequireRecord("object", "expected-label-object");

function requireMockCall(mock: ReturnType<typeof vi.fn>, callIndex: number): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

function requireSpawnOptions(spawn: ReturnType<typeof vi.fn>, callIndex: number) {
  return requireRecord(requireMockCall(spawn, callIndex)[2], "spawn options");
}

function requireSpawnEnv(spawn: ReturnType<typeof vi.fn>, callIndex: number) {
  return requireRecord(requireSpawnOptions(spawn, callIndex).env, "spawn env");
}

describe("watch-node script", () => {
  it.each(["resolve", "reject"] as const)(
    "retains the watch lock until physical close finishes with %s",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-watch-close-" }, async (cwd) => {
        const closing = createDeferredCore();
        const watching = createDeferredCore();
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
            watching.resolve();
            return observe(watcher, options);
          },
        });
        await watchReady();
        const failure = new Error("physical watcher close failed");
        const completion =
          outcome === "reject" ? expect(run).rejects.toBe(failure) : expect(run).resolves.toBe(0);
        try {
          await watching.promise;
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

  it("preserves raw Unix runner SIGTERM without doctor or restart", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawn = vi.fn(() => child);
    const fakeProcess = Object.assign(createFakeProcess(), { platform: "linux" });
    const run = runWatch({
      args: ["gateway"],
      env: {},
      process: fakeProcess,
      spawn,
      createWatcher: () => ({ on: () => {}, close: async () => {} }),
    });
    await watchReady();
    child.emit("exit", null, "SIGTERM");
    await expect(run).resolves.toBe("SIGTERM");
    expect(spawn).toHaveBeenCalledOnce();
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it.each(["restart", "shutdown", "doctor", "startup-error"] as const)(
    "does not hide raw Unix signal loss during %s",
    async (phase) => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      const doctor = Object.assign(new EventEmitter(), { kill: vi.fn() });
      const spawn = vi.fn().mockReturnValueOnce(child).mockReturnValueOnce(doctor);
      const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
      const fakeProcess = Object.assign(createFakeProcess(), { platform: "linux" });
      const startupError = new Error("watcher dependency failed");
      const run = runWatch({
        args: ["gateway"],
        env: {},
        fs: { existsSync: () => true },
        process: fakeProcess,
        spawn,
        ...(phase === "startup-error"
          ? {
              loadWatcher: async () => {
                throw startupError;
              },
            }
          : { createWatcher: (_paths, options) => observe(watcher, options) }),
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

  it("preserves requested Windows SIGTERM rebuilds and shutdown", async () => {
    const first = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const second = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
    const fakeProcess = Object.assign(createFakeProcess(), { platform: "win32" });
    const run = runWatch({
      args: ["gateway"],
      env: {},
      fs: { existsSync: () => true },
      process: fakeProcess,
      spawn,
      createWatcher: (_paths, options) => observe(watcher, options),
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
    const child = createKillableChild();
    const spawn = vi.fn(() => child);
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
    });
    const watch = vi.fn((_paths: string[], options: Parameters<typeof observe>[1]) =>
      observe(watcher, options),
    );
    let resolveLoadWatcher: (value: typeof watch) => void = () => {};
    const loadWatcher = vi.fn(
      () =>
        new Promise<typeof watch>((resolve) => {
          resolveLoadWatcher = resolve;
        }),
    );
    const fakeProcess = createFakeProcess();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      env: { LAUNCH_JOB_LABEL: "ai.openclaw.gateway" },
      loadWatcher,
      process: fakeProcess,
      spawn,
    });
    await watchReady();

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnEnv = requireSpawnEnv(spawn, 0);
    expect(spawnEnv.LAUNCH_JOB_LABEL).toBe("ai.openclaw.gateway");
    expect(spawnEnv.OPENCLAW_NO_RESPAWN).toBe("1");
    expect(spawnEnv.OPENCLAW_TRACE_SYNC_IO).toBeUndefined();
    expect(loadWatcher).toHaveBeenCalledTimes(1);
    expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        loadWatcher.mock.invocationCallOrder[0],
        "loadWatcher.mock.invocationCallOrder[0] test invariant",
      ),
    );

    resolveLoadWatcher(watch);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(watch).toHaveBeenCalledTimes(1);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("refreshes generated asset paths before each runner start", async () => {
    const childA = createAutoExitChild();
    const childB = createKillableChild();
    const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
    });
    const fakeProcess = createFakeProcess();
    const pathClassifier = {
      refreshGeneratedPluginAssetPaths: vi.fn(),
      isRestartRelevantRunNodePath: vi.fn(() => true),
    };

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher: (_paths, options) => observe(watcher, options),
      fs: { existsSync: () => true },
      pathClassifier,
      process: fakeProcess,
      spawn,
    });
    await watchReady();

    expect(pathClassifier.refreshGeneratedPluginAssetPaths).toHaveBeenCalledTimes(1);
    watcher.emit("change", "extensions/browser/package.json");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(pathClassifier.refreshGeneratedPluginAssetPaths).toHaveBeenCalledTimes(2);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
  });

  it("runs doctor once and restarts when gateway exits nonzero", async () => {
    const gatewayA = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const doctor = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const gatewayB = createKillableChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(gatewayA)
      .mockReturnValueOnce(doctor)
      .mockReturnValueOnce(gatewayB);
    const { watcher, fakeProcess, runPromise } = await startWatchRun({ env: {}, spawn });

    gatewayA.emit("exit", 1, null);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(spawn).toHaveBeenCalledTimes(3);
    const restartedGatewaySpawnCall = requireMockCall(spawn, 2);
    expect(restartedGatewaySpawnCall[0]).toBe("/usr/local/bin/node");
    expect(restartedGatewaySpawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
    expect(requireSpawnOptions(spawn, 2).stdio).toBe("inherit");

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(gatewayB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("does not run doctor after a gateway failure when auto doctor is disabled", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      env: { OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "0" },
      process: fakeProcess,
      spawn,
    });
    await watchReady();

    child.emit("exit", 1, null);
    const exitCode = await runPromise;

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("restarts when the runner exits with a SIGTERM-derived code unexpectedly", async () => {
    const childA = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
    });
    const childB = createKillableChild();
    const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    const { watcher, fakeProcess, runPromise } = await startWatchRun({ spawn });

    childA.emit("exit", 143, null);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(2);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("ignores test-only changes and restarts on non-test source changes", async () => {
    const childA = createAutoExitChild();
    const childB = createAutoExitChild();
    const childC = createAutoExitChild();
    const childD = createKillableChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(childA)
      .mockReturnValueOnce(childB)
      .mockReturnValueOnce(childC)
      .mockReturnValueOnce(childD);
    const { watcher, fakeProcess, runPromise } = await startWatchRun({ spawn });

    watcher.emit("change", "src/infra/watch-node.test.ts");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", "src/infra/watch-node.test.tsx");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", "src/infra/watch-node-test-helpers.ts");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", VOICE_CALL_README);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", VOICE_CALL_MANIFEST);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(2);

    watcher.emit("change", VOICE_CALL_PACKAGE);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(3);

    watcher.emit("change", "src/infra/watch-node.ts");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(childC.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(4);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
  });

  it("keeps the healthy child alive until a concurrently rebuilt dist entry returns", async () => {
    const childA = createKillableChild();
    const childB = createKillableChild();
    const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
    });
    const fakeProcess = createFakeProcess();
    let distEntryExists = false;
    let resumePoll: (() => void) | undefined;
    const sleep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resumePoll = resolve;
        }),
    );
    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher: (_paths, options) => observe(watcher, options),
      fs: { existsSync: () => distEntryExists },
      process: fakeProcess,
      sleep,
      spawn,
    });
    await watchReady();

    watcher.emit("change", "src/infra/restart.ts");
    watcher.emit("change", "src/infra/restart.ts");
    expect(childA.kill).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);

    distEntryExists = true;
    resumePoll?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(2);

    fakeProcess.emit("SIGINT");
    expect(await runPromise).toBe(130);
  });

  it("does not resurrect a deferred child after watcher shutdown", async () => {
    const child = createKillableChild();
    const spawn = vi.fn(() => child);
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
    });
    const fakeProcess = createFakeProcess();
    let resumePoll: (() => void) | undefined;
    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher: (_paths, options) => observe(watcher, options),
      fs: { existsSync: () => false },
      process: fakeProcess,
      sleep: () =>
        new Promise<void>((resolve) => {
          resumePoll = resolve;
        }),
      spawn,
    });
    await watchReady();

    watcher.emit("change", "src/infra/restart.ts");
    fakeProcess.emit("SIGINT");
    expect(await runPromise).toBe(130);
    resumePoll?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("waits for the build entry when the healthy child exits during deferral", async () => {
    const childA = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const childB = createKillableChild();
    const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
    });
    const fakeProcess = createFakeProcess();
    let distEntryExists = false;
    const resumePolls: Array<() => void> = [];
    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher: (_paths, options) => observe(watcher, options),
      fs: { existsSync: () => distEntryExists },
      process: fakeProcess,
      sleep: () =>
        new Promise<void>((resolve) => {
          resumePolls.push(resolve);
        }),
      spawn,
    });
    await watchReady();

    watcher.emit("change", "src/infra/restart.ts");
    childA.emit("exit", 1, null);
    watcher.emit("change", "src/infra/restart.ts");
    expect(spawn).toHaveBeenCalledTimes(1);

    distEntryExists = true;
    for (const resume of resumePolls) {
      resume();
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(spawn).toHaveBeenCalledTimes(2);

    fakeProcess.emit("SIGINT");
    expect(await runPromise).toBe(130);
  });

  it("replaces an existing watcher lock holder before starting", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();
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
      const signalProcess = vi.fn<NonNullable<WatchRunParams["signalProcess"]>>((pid, signal) => {
        if (signal === 0) {
          if (pid === 2121 && existingWatcherAlive) {
            return;
          }
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        if (pid === 2121 && signal === "SIGTERM") {
          existingWatcherAlive = false;
          return;
        }
        throw new Error(`unexpected signal ${signal} for pid ${pid}`);
      });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        createWatcher,
        cwd,
        now: () => 1_700_000_000_000,
        process: fakeProcess,
        signalProcess,
        sleep: async () => {},
        spawn,
      });
      await watchReady();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(signalProcess).toHaveBeenCalledWith(2121, "SIGTERM");
      expect(spawn).toHaveBeenCalledTimes(1);
      const lockRecord = requireRecord(JSON.parse(fs.readFileSync(lockPath, "utf8")), "watch lock");
      expect(lockRecord.pid).toBe(4242);
      expect(lockRecord.command).toBe("gateway --force");
      expect(lockRecord.watchSession).toBe("1700000000000-4242");

      fakeProcess.emit("SIGINT");
      const exitCode = await runPromise;

      expect(exitCode).toBe(130);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });
  });
});
