import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runNodeWatchedPaths } from "../../scripts/run-node.mjs";
import { runWatchMain } from "../../scripts/watch-node.mjs";

const createFakeProcess = () =>
  Object.assign(new EventEmitter(), {
    pid: 4242,
    execPath: "/usr/local/bin/node",
  }) as unknown as NodeJS.Process;

describe("watch-node script", () => {
  it("wires node watch to run-node with watched source/config paths", async () => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
    });
    const spawn = vi.fn(() => child);
    const fakeProcess = createFakeProcess();

    const runPromise = runWatchMain({
      args: ["gateway", "--force"],
      cwd: "/tmp/openclaw",
      env: { PATH: "/usr/bin" },
      now: () => 1700000000000,
      process: fakeProcess,
      spawn,
    });

    queueMicrotask(() => child.emit("exit", 0, null));
    const exitCode = await runPromise;

    expect(exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      [
        ...runNodeWatchedPaths.flatMap((watchPath) => ["--watch-path", watchPath]),
        "--watch-preserve-output",
        "scripts/run-node.mjs",
        "gateway",
        "--force",
      ],
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
  });

  it("terminates child on SIGINT and returns shell interrupt code", async () => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
    });
    const spawn = vi.fn(() => child);
    const fakeProcess = createFakeProcess();

    const runPromise = runWatchMain({
      args: ["gateway", "--force"],
      process: fakeProcess,
      spawn,
    });

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;

    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });
});
