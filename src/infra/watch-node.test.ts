import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runNodeWatchedPaths } from "../../scripts/run-node.mjs";
import { runWatchMain } from "../../scripts/watch-node.mjs";
import { bundledPluginFile } from "../../test/helpers/bundled-plugin-paths.js";

const VOICE_CALL_README = bundledPluginFile("voice-call", "README.md");
const VOICE_CALL_MANIFEST = bundledPluginFile("voice-call", "openclaw.plugin.json");
const VOICE_CALL_PACKAGE = bundledPluginFile("voice-call", "package.json");
const VOICE_CALL_INDEX = bundledPluginFile("voice-call", "index.ts");
const VOICE_CALL_RUNTIME = bundledPluginFile("voice-call", "src/runtime.ts");

const createFakeProcess = () =>
  Object.assign(new EventEmitter(), {
    pid: 4242,
    execPath: "/usr/local/bin/node",
  }) as unknown as NodeJS.Process;

const createWatchHarness = () => {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => {}),
  });
  const spawn = vi.fn(() => child);
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
  });
  const createWatcher = vi.fn(() => watcher);
  const fakeProcess = createFakeProcess();
  return { child, spawn, watcher, createWatcher, fakeProcess };
};

describe("watch-node script", () => {
  it("wires chokidar watch to run-node with watched source/config paths", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatchMain({
      args: ["gateway", "--force"],
      cwd: "/tmp/openclaw",
      createWatcher,
      env: { PATH: "/usr/bin" },
      now: () => 1700000000000,
      process: fakeProcess,
      spawn,
    });

    expect(createWatcher).toHaveBeenCalledTimes(1);
    const firstWatcherCall = createWatcher.mock.calls[0];
    expect(firstWatcherCall).toBeDefined();
    const [watchPaths, watchOptions] = firstWatcherCall as unknown as [
      string[],
      { ignoreInitial: boolean; ignored: (watchPath: string) => boolean },
    ];
    expect(watchPaths).toEqual(runNodeWatchedPaths);
    expect(watchPaths).toContain("extensions");
    expect(watchPaths).toContain("tsdown.config.ts");
    expect(watchOptions.ignoreInitial).toBe(true);
    expect(watchOptions.ignored("src/infra/watch-node.test.ts")).toBe(true);
    expect(watchOptions.ignored("src/infra/watch-node.test.tsx")).toBe(true);
    expect(watchOptions.ignored("src/infra/watch-node-test-helpers.ts")).toBe(true);
    expect(watchOptions.ignored(VOICE_CALL_README)).toBe(true);
    expect(watchOptions.ignored(VOICE_CALL_MANIFEST)).toBe(false);
    expect(watchOptions.ignored(VOICE_CALL_PACKAGE)).toBe(false);
    expect(watchOptions.ignored(VOICE_CALL_INDEX)).toBe(false);
    expect(watchOptions.ignored(VOICE_CALL_RUNTIME)).toBe(false);
    expect(watchOptions.ignored("src/infra/watch-node.ts")).toBe(false);
    expect(watchOptions.ignored("tsconfig.json")).toBe(false);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      ["scripts/run-node.mjs", "gateway", "--force"],
      expect.objectContaining({
        cwd: "/tmp/openclaw",
        stdio: "inherit",
        env: expect.objectContaining({
          PATH: "/usr/bin",
          OPENCLAW_WATCH_MODE: "1",
          OPENCLAW_WATCH_SESSION: "1700000000000-4242",
          OPENCLAW_WATCH_COMMAND: "gateway --force",
        }),
      }),
    );
    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("terminates child on SIGINT and returns shell interrupt code", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatchMain({
      args: ["gateway", "--force"],
      createWatcher,
      process: fakeProcess,
      spawn,
    });

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;

    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("terminates child on SIGTERM and returns shell terminate code", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatchMain({
      args: ["gateway", "--force"],
      createWatcher,
      process: fakeProcess,
      spawn,
    });

    fakeProcess.emit("SIGTERM");
    const exitCode = await runPromise;

    expect(exitCode).toBe(143);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("ignores test-only changes and restarts on non-test source changes", async () => {
    const childA = Object.assign(new EventEmitter(), {
      kill: vi.fn(function () {
        queueMicrotask(() => childA.emit("exit", 0, null));
      }),
    });
    const childB = Object.assign(new EventEmitter(), {
      kill: vi.fn(function () {
        queueMicrotask(() => childB.emit("exit", 0, null));
      }),
    });
    const childC = Object.assign(new EventEmitter(), {
      kill: vi.fn(function () {
        queueMicrotask(() => childC.emit("exit", 0, null));
      }),
    });
    const childD = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {}),
    });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(childA)
      .mockReturnValueOnce(childB)
      .mockReturnValueOnce(childC)
      .mockReturnValueOnce(childD);
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
    });
    const createWatcher = vi.fn(() => watcher);
    const fakeProcess = createFakeProcess();

    const runPromise = runWatchMain({
      args: ["gateway", "--force"],
      createWatcher,
      process: fakeProcess,
      spawn,
    });

    watcher.emit("change", "src/infra/watch-node.test.ts");
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", "src/infra/watch-node.test.tsx");
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", "src/infra/watch-node-test-helpers.ts");
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", VOICE_CALL_README);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", VOICE_CALL_MANIFEST);
    await new Promise((resolve) => setImmediate(resolve));
    expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(2);

    watcher.emit("change", VOICE_CALL_PACKAGE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(3);

    watcher.emit("change", "src/infra/watch-node.ts");
    await new Promise((resolve) => setImmediate(resolve));
    expect(childC.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(4);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
  });

  it("kills child and exits when watcher emits an error", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatchMain({
      args: ["gateway", "--force"],
      createWatcher,
      process: fakeProcess,
      spawn,
    });

    watcher.emit("error", new Error("watch failed"));
    const exitCode = await runPromise;

    expect(exitCode).toBe(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });
  it("prints recovery guidance when chokidar fails with invalid package config", async () => {
    const error = Object.assign(
      new Error(
        'Invalid package config /tmp/openclaw/node_modules/chokidar/package.json while importing "chokidar" from /tmp/openclaw/scripts/watch-node.mjs.',
      ),
      { code: "ERR_INVALID_PACKAGE_CONFIG" },
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeProcess = createFakeProcess();

    await expect(
      runWatchMain({
        args: ["gateway", "--force"],
        cwd: "/tmp/openclaw",
        loadChokidar: vi.fn(async () => {
          throw error;
        }),
        process: fakeProcess,
      }),
    ).rejects.toBe(error);

    expect(errorSpy).toHaveBeenCalledWith("");
    expect(errorSpy).toHaveBeenCalledWith(
      "[openclaw] gateway:watch could not start because a dependency package config looks corrupted.",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[openclaw] Invalid package config: /tmp/openclaw/node_modules/chokidar/package.json",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[openclaw] This usually means a file in node_modules is empty or truncated.",
    );
    expect(errorSpy).toHaveBeenCalledWith("[openclaw] Recommended recovery:");
    expect(errorSpy).toHaveBeenCalledWith("[openclaw]   rm -rf node_modules");
    expect(errorSpy).toHaveBeenCalledWith("[openclaw]   pnpm store prune");
    expect(errorSpy).toHaveBeenCalledWith("[openclaw]   pnpm install");
    expect(errorSpy).toHaveBeenCalledWith("");
    expect(errorSpy).toHaveBeenCalledWith("[openclaw] Original error:");
    expect(errorSpy).toHaveBeenCalledWith(error);

    errorSpy.mockRestore();
  });
});
