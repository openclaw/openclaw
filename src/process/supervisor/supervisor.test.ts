import { describe, expect, it } from "vitest";
import { createProcessSupervisor } from "./supervisor.js";

describe("process supervisor", () => {
  it("spawns child runs and captures output", async () => {
    const supervisor = createProcessSupervisor();
    const run = await supervisor.spawn({
      sessionId: "s1",
      backendId: "test",
      mode: "child",
      argv: [process.execPath, "-e", 'process.stdout.write("ok")'],
      timeoutMs: 2_000,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("exit");
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe("ok");
  });

  it("enforces no-output timeout for silent processes", async () => {
    const supervisor = createProcessSupervisor();
    const run = await supervisor.spawn({
      sessionId: "s1",
      backendId: "test",
      mode: "child",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 5_000,
      noOutputTimeoutMs: 30,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("cancels prior scoped run when replaceExistingScope is enabled", async () => {
    const supervisor = createProcessSupervisor();
    const first = await supervisor.spawn({
      sessionId: "s1",
      backendId: "test",
      scopeKey: "scope:a",
      mode: "child",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 10_000,
      stdinMode: "pipe-open",
    });

    const second = await supervisor.spawn({
      sessionId: "s1",
      backendId: "test",
      scopeKey: "scope:a",
      replaceExistingScope: true,
      mode: "child",
      argv: [process.execPath, "-e", 'process.stdout.write("new")'],
      timeoutMs: 2_000,
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
    const run = await supervisor.spawn({
      sessionId: "s-timeout",
      backendId: "test",
      mode: "child",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 1,
      stdinMode: "pipe-closed",
    });
    const exit = await run.wait();
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("cancelAll terminates all active runs", async () => {
    const supervisor = createProcessSupervisor();
    const a = await supervisor.spawn({
      sessionId: "s1",
      backendId: "test",
      mode: "child",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 10_000,
      stdinMode: "pipe-closed",
    });
    const b = await supervisor.spawn({
      sessionId: "s2",
      backendId: "test",
      mode: "child",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 10_000,
      stdinMode: "pipe-closed",
    });

    supervisor.cancelAll();

    const [exitA, exitB] = await Promise.all([a.wait(), b.wait()]);
    expect(exitA.reason === "manual-cancel" || exitA.reason === "signal").toBe(true);
    expect(exitB.reason === "manual-cancel" || exitB.reason === "signal").toBe(true);
  });

  it("cancelAll on empty supervisor is a no-op", () => {
    const supervisor = createProcessSupervisor();
    // Should not throw when there are no active runs
    supervisor.cancelAll();
  });

  it("cancelAll is resilient to partial cancellation failures", async () => {
    const supervisor = createProcessSupervisor();
    const a = await supervisor.spawn({
      sessionId: "s1",
      backendId: "test",
      mode: "child",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 10_000,
      stdinMode: "pipe-closed",
    });
    const b = await supervisor.spawn({
      sessionId: "s2",
      backendId: "test",
      mode: "child",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 10_000,
      stdinMode: "pipe-closed",
    });

    // Cancel first run manually so it's already gone when cancelAll runs
    a.cancel();
    await a.wait();

    // cancelAll should still terminate the remaining run without throwing
    supervisor.cancelAll();
    const exitB = await b.wait();
    expect(exitB.reason === "manual-cancel" || exitB.reason === "signal").toBe(true);
  });

  it("full shutdown: zero orphan PIDs remain after cancelAll", async () => {
    const supervisor = createProcessSupervisor();
    const runs = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        supervisor.spawn({
          sessionId: `s-shutdown-${i}`,
          backendId: "test",
          mode: "child",
          argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
          timeoutMs: 30_000,
          stdinMode: "pipe-closed",
        }),
      ),
    );

    const pids = runs.map((r) => r.pid).filter(Boolean) as number[];
    expect(pids.length).toBe(3);

    supervisor.cancelAll();
    await Promise.all(runs.map((r) => r.wait()));

    // Verify all child PIDs are no longer alive
    for (const pid of pids) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        // Expected: process no longer exists
      }
      expect(alive).toBe(false);
    }
  });

  it("can stream output without retaining it in RunExit payload", async () => {
    const supervisor = createProcessSupervisor();
    let streamed = "";
    const run = await supervisor.spawn({
      sessionId: "s-capture",
      backendId: "test",
      mode: "child",
      argv: [process.execPath, "-e", 'process.stdout.write("streamed")'],
      timeoutMs: 2_000,
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
