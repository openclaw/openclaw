import { ChildProcess, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
  spawnSync: vi.fn(),
}));

beforeEach(() => {
  spawn.mockReset();
  vi.mocked(spawnSync).mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createChild(withOutput = false) {
  const child = new ChildProcess();
  let exitCode: number | null = null;
  Object.defineProperties(child, {
    pid: { value: 12345 },
    exitCode: { get: () => exitCode },
    stdout: { value: withOutput ? new PassThrough() : null, writable: true },
    stderr: { value: null, writable: true },
    stdio: { get: () => [child.stdin, child.stdout, child.stderr, null] },
  });
  const kill = vi.spyOn(child, "kill").mockReturnValue(false);
  spawn.mockReturnValue(child);
  return {
    child,
    kill,
    exit: () => {
      exitCode = 0;
      child.emit("exit", 0, null);
    },
  };
}

type GroupState = "live" | "gone" | "zombie" | "indeterminate";

function observeGroup(initial: GroupState = "live") {
  let state = initial;
  const signals: { signal: string | number; at: number }[] = [];
  const startedAt = Date.now();
  const onSignal = vi.fn();
  vi.spyOn(process, "kill").mockImplementation((pid, signal = "SIGTERM") => {
    expect(pid).toBe(-12345);
    if (state === "gone") {
      throw Object.assign(new Error("group is gone"), { code: "ESRCH" });
    }
    if (signal !== 0) {
      signals.push({ signal, at: Date.now() - startedAt });
      onSignal(signal);
    }
    if (state === "indeterminate") {
      throw Object.assign(new Error("group observation unavailable"), { code: "EIO" });
    }
    return true;
  });
  vi.mocked(spawnSync).mockImplementation(() => ({
    pid: 12346,
    output: [],
    status: 0,
    signal: null,
    stdout: state === "zombie" ? "12345 Z\n12345 Z\n" : "12345 S\n",
    stderr: "",
  }));
  return {
    signals,
    onSignal,
    setState: (next: GroupState) => {
      state = next;
    },
  };
}

function runChild(
  fixture: ReturnType<typeof createChild>,
  options: Partial<Parameters<typeof runManagedCommand>[0]> = {},
) {
  return runManagedCommand({
    bin: "fixture",
    platform: "linux",
    shell: false,
    stdio: fixture.child.stdout ? "pipe" : "ignore",
    // The mocked process owns no filesystem resources.
    env: { TMPDIR: process.cwd() },
    requireProcessTreeExit: true,
    onReady: fixture.exit,
    ...options,
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("managed child natural process-group drainage", () => {
  it.each(["gone", "zombie"] as const)(
    "joins a group that becomes %s after leader exit without sending a signal",
    async (terminalState) => {
      const fixture = createChild();
      const group = observeGroup();
      const command = runChild(fixture);
      setTimeout(() => group.setState(terminalState), 100);

      await vi.advanceTimersByTimeAsync(100);

      expect(await command).toEqual({ value: 0 });
      expect(group.signals).toEqual([]);
      expect(fixture.kill).not.toHaveBeenCalled();
      if (terminalState === "zombie") {
        expect(spawnSync).toHaveBeenCalledWith(
          "ps",
          ["-s", "12345", "-L", "-o", "pgid=,state="],
          expect.objectContaining({ timeout: expect.any(Number) }),
        );
      }
    },
  );

  it("waits for the actual output close event after the group drains", async () => {
    const fixture = createChild(true);
    const group = observeGroup();
    let settled = false;
    const command = runChild(fixture).then((result) => {
      settled = true;
      return result;
    });
    setTimeout(() => group.setState("gone"), 100);
    setTimeout(() => fixture.child.stdout?.emit("close"), 150);

    await vi.advanceTimersByTimeAsync(125);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(25);

    expect(await command).toEqual({ value: 0 });
    expect(group.signals).toEqual([]);
    fixture.child.stdout?.destroy();
  });

  it.each(["live", "indeterminate"] as const)(
    "fails a persistently %s group within the original five-second total bound",
    async (state) => {
      const fixture = createChild();
      const group = observeGroup(state);
      const startedAt = Date.now();
      const command = runChild(fixture);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(await command).toMatchObject({
        error: {
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: state,
        },
      });
      expect(group.signals).toEqual([{ signal: "SIGKILL", at: 2_500 }]);
      expect(Date.now() - startedAt).toBe(5_000);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("still fails when the owner must kill a group that did not drain", async () => {
    const fixture = createChild();
    const group = observeGroup();
    group.onSignal.mockImplementation(() => group.setState("gone"));
    const command = runChild(fixture);

    await vi.advanceTimersByTimeAsync(2_500);

    expect(await command).toMatchObject({
      error: { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "terminated" },
    });
    expect(group.signals).toEqual([{ signal: "SIGKILL", at: 2_500 }]);
  });

  it("does not certify escaped output even after the owned group disappears", async () => {
    const fixture = createChild(true);
    const group = observeGroup("gone");
    const command = runChild(fixture);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await command).toMatchObject({
      error: { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "indeterminate" },
    });
    expect(group.signals).toEqual([]);
    expect(fixture.child.stdout?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("charges synchronous snapshots to the natural and total cleanup deadlines", async () => {
    const fixture = createChild();
    const group = observeGroup();
    const startedAt = Date.now();
    const probes: { at: number; timeout: number }[] = [];
    vi.mocked(spawnSync).mockImplementation((_bin, _args, options) => {
      const timeout = options?.timeout;
      expect(timeout).toBeGreaterThan(0);
      probes.push({ at: Date.now() - startedAt, timeout: timeout! });
      vi.setSystemTime(Date.now() + timeout!);
      return {
        pid: 12346,
        output: [],
        status: null,
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("snapshot timed out"), { code: "ETIMEDOUT" }),
      };
    });
    const command = runChild(fixture);

    await vi.advanceTimersByTimeAsync(0);

    expect(await command).toMatchObject({
      error: { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "live" },
    });
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      const deadline = probe.at < 2_500 ? 2_500 : 5_000;
      expect(probe.at + probe.timeout).toBeLessThanOrEqual(deadline);
    }
    expect(group.signals).toEqual([{ signal: "SIGKILL", at: 2_500 }]);
    expect(Date.now() - startedAt).toBe(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["live", "gone"] as const)(
    "preserves zero-budget behavior for a %s group",
    async (state) => {
      const fixture = createChild();
      const group = observeGroup(state);
      group.onSignal.mockImplementation(() => group.setState("gone"));
      const command = runChild(fixture, { cleanupDrainTimeoutMs: 0 });

      await vi.advanceTimersByTimeAsync(0);

      if (state === "gone") {
        expect(await command).toEqual({ value: 0 });
        expect(group.signals).toEqual([]);
      } else {
        expect(await command).toMatchObject({
          error: { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "terminated" },
        });
        expect(group.signals).toEqual([{ signal: "SIGKILL", at: 0 }]);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("still sends cancellation immediately and preserves its existing grace", async () => {
    const fixture = createChild();
    const group = observeGroup();
    const abort = new AbortController();
    const command = runChild(fixture, {
      signal: abort.signal,
      abortKillGraceMs: 100,
      onReady: () => abort.abort(),
    });
    setTimeout(() => {
      group.setState("gone");
      fixture.exit();
    }, 50);

    await vi.advanceTimersByTimeAsync(50);

    expect(await command).toMatchObject({ error: { code: "ABORT_ERR" } });
    expect(group.signals).toEqual([{ signal: "SIGTERM", at: 0 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards an abort received during natural drainage without replacing the finalizer", async () => {
    const fixture = createChild();
    const group = observeGroup();
    const abort = new AbortController();
    const startedAt = Date.now();
    group.onSignal.mockImplementation(() => group.setState("gone"));
    const command = runChild(fixture, {
      signal: abort.signal,
      abortKillGraceMs: 100,
    }).then((result) => ({ result, elapsed: Date.now() - startedAt }));
    setTimeout(() => abort.abort(), 100);

    // Drain the original whole allowance even on failure, so the regression
    // cannot leave an unfinished finalizer in the next test's real clock.
    await vi.advanceTimersByTimeAsync(5_000);

    const outcome = await command;
    expect(outcome.result).toMatchObject({ error: { code: "ABORT_ERR" } });
    expect(group.signals).toEqual([{ signal: "SIGTERM", at: 100 }]);
    expect(outcome.elapsed).toBeLessThanOrEqual(125);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a late abort's grace and resistant group inside the original cleanup budget", async () => {
    const fixture = createChild();
    const group = observeGroup();
    const abort = new AbortController();
    const startedAt = Date.now();
    const command = runChild(fixture, {
      signal: abort.signal,
      abortKillGraceMs: 10_000,
    });
    setTimeout(() => abort.abort(), 100);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await command).toMatchObject({
      error: { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "live" },
    });
    expect(group.signals).toEqual([
      { signal: "SIGTERM", at: 100 },
      { signal: "SIGKILL", at: 2_500 },
    ]);
    expect(Date.now() - startedAt).toBe(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
