import { describe, expect, it } from "vitest";
import { createProcessSupervisor } from "./supervisor.js";

type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;
type SpawnOptions = Parameters<ProcessSupervisor["spawn"]>[0];
type ChildSpawnOptions = Omit<Extract<SpawnOptions, { mode: "child" }>, "backendId" | "mode">;

async function spawnChild(supervisor: ProcessSupervisor, options: ChildSpawnOptions) {
  return supervisor.spawn({
    ...options,
    backendId: "test",
    mode: "child",
  });
}

describe("process supervisor", () => {
  it("spawns child runs and captures output", async () => {
    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: [process.execPath, "-e", 'process.stdout.write("ok")'],
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("exit");
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe("ok");
  });

  it("enforces no-output timeout for silent processes", async () => {
    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 40)"],
      timeoutMs: 500,
      noOutputTimeoutMs: 20,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("cancels prior scoped run when replaceExistingScope is enabled", async () => {
    const supervisor = createProcessSupervisor();
    const first = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 40)"],
      timeoutMs: 500,
      stdinMode: "pipe-open",
    });

    const second = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      replaceExistingScope: true,
      argv: [process.execPath, "-e", 'process.stdout.write("new")'],
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    const firstExit = await first.wait();
    const secondExit = await second.wait();
    expect(firstExit.reason === "manual-cancel" || firstExit.reason === "signal").toBe(true);
    expect(secondExit.reason).toBe("exit");
    expect(secondExit.stdout).toBe("new");
  });

  it("applies overall timeout even for near-immediate timer firing", async () => {
    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 40)"],
      timeoutMs: 1,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("can stream output without retaining it in RunExit payload", async () => {
    const supervisor = createProcessSupervisor();
    let streamed = "";
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture",
      argv: [process.execPath, "-e", 'process.stdout.write("streamed")'],
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      captureOutput: false,
      onStdout: (chunk) => {
        streamed += chunk;
      },
    });
    const exit = await run.wait();
    expect(streamed).toBe("streamed");
    expect(exit.stdout).toBe("");
  });
});
