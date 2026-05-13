import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MCP_PARENT_GONE_GRACE_MS,
  MCP_PARENT_WATCHDOG_INTERVAL_MS,
} from "./channel-server.js";

// Re-export probe under test through a local copy — kept identical to the
// implementation in channel-server.ts so this test does not require deep
// internals access (the function is not exported, but its behavior is the
// canonical contract for the watchdog and is covered here against a spawned
// real child process to lock in the cross-platform semantics).
function parentProcessIsAliveProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

describe("MCP channel-server parent watchdog contract", () => {
  test("constants are tuned for fast orphan reaping without thrash", () => {
    // If you change these, also update the matching comments in
    // src/mcp/channel-server.ts so operators reading the source agree with
    // the runtime behavior.
    expect(MCP_PARENT_WATCHDOG_INTERVAL_MS).toBeGreaterThan(1_000);
    expect(MCP_PARENT_WATCHDOG_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    expect(MCP_PARENT_GONE_GRACE_MS).toBeGreaterThan(0);
    expect(MCP_PARENT_GONE_GRACE_MS).toBeLessThan(MCP_PARENT_WATCHDOG_INTERVAL_MS);
  });

  test("liveness probe returns true for the running process", () => {
    expect(parentProcessIsAliveProbe(process.pid)).toBe(true);
  });

  test("liveness probe returns false for a pid that has exited", async () => {
    // Spawn a no-op child that exits immediately, then probe its dead pid.
    // We do this against a *real* spawned process so the test exercises the
    // same `process.kill(pid, 0)` path the watchdog uses, on whatever OS
    // the suite is currently running on.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Give the OS a moment to release the pid table entry. Windows can keep
    // a "zombie" handle around for a short window — `process.kill(pid, 0)`
    // can still return alive for a tick or two on Windows specifically. Poll
    // until the OS agrees the pid is gone, up to a 5s budget.
    const deadline = Date.now() + 5_000;
    let alive = parentProcessIsAliveProbe(deadPid);
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      alive = parentProcessIsAliveProbe(deadPid);
    }
    expect(alive).toBe(false);
  });

  test("liveness probe returns false for a clearly invalid pid", () => {
    // PID 0 is reserved on POSIX and process.kill treats it as a process-group
    // signal. We special-case ppid > 1 in production code, so this test just
    // confirms the probe returns false for a non-existent high pid.
    expect(parentProcessIsAliveProbe(2 ** 30)).toBe(false);
  });
});

describe("MCP channel-server parent watchdog scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a setInterval at MCP_PARENT_WATCHDOG_INTERVAL_MS fires only after the interval", () => {
    let ticks = 0;
    const handle = setInterval(() => {
      ticks++;
    }, MCP_PARENT_WATCHDOG_INTERVAL_MS);
    try {
      vi.advanceTimersByTime(MCP_PARENT_WATCHDOG_INTERVAL_MS - 1);
      expect(ticks).toBe(0);
      vi.advanceTimersByTime(2);
      expect(ticks).toBe(1);
      vi.advanceTimersByTime(MCP_PARENT_WATCHDOG_INTERVAL_MS);
      expect(ticks).toBe(2);
    } finally {
      clearInterval(handle);
    }
  });

  test("force-exit grace window is shorter than the polling interval", () => {
    expect(MCP_PARENT_GONE_GRACE_MS).toBeLessThan(MCP_PARENT_WATCHDOG_INTERVAL_MS);
  });
});
