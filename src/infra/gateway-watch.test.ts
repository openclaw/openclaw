import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildGatewayWatchArgs, runGatewayWatchMain } from "../../scripts/gateway-watch.mjs";

const createFakeProcess = () =>
  Object.assign(new EventEmitter(), {
    pid: 2026,
    execPath: "/usr/local/bin/node",
  }) as unknown as NodeJS.Process;

describe("gateway-watch script", () => {
  it("builds default non-Windows args with --force", () => {
    expect(buildGatewayWatchArgs({ platform: "linux", args: ["--raw-stream"] })).toEqual([
      "gateway",
      "--force",
      "--raw-stream",
    ]);
  });

  it("builds native Windows gateway run args", () => {
    expect(buildGatewayWatchArgs({ platform: "win32", args: ["--verbose"] })).toEqual([
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      "18789",
      "--allow-unconfigured",
      "--verbose",
    ]);
  });

  it("stops Windows daemon best-effort before starting watcher", async () => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
    });
    const spawn = vi.fn(() => child);
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const fakeProcess = createFakeProcess();

    const runPromise = runGatewayWatchMain({
      platform: "win32",
      args: ["--verbose"],
      process: fakeProcess,
      spawn,
      spawnSync,
      cwd: "C:/repo/openclaw",
      env: { PATH: "C:/Windows/System32" },
      now: () => 1700000000000,
    });

    queueMicrotask(() => child.emit("exit", 0, null));
    const exitCode = await runPromise;

    expect(exitCode).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      ["openclaw.mjs", "gateway", "stop"],
      expect.objectContaining({
        cwd: "C:/repo/openclaw",
      }),
    );
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      expect.arrayContaining(["scripts/run-node.mjs", "gateway", "run", "--bind", "loopback"]),
      expect.any(Object),
    );
  });
});
