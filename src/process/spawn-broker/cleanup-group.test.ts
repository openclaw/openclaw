import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import {
  drainCurrentBrokerProcessGroup,
  terminateBrokerProcessGroup,
  terminateLostBrokerChild,
} from "./cleanup.js";

const boundary = vi.hoisted(() => ({
  foreignProcfs: false,
  census: vi.fn(),
  identity: vi.fn(),
  dead: vi.fn(),
  delay: vi.fn(),
  groupGone: vi.fn(),
  killTree: vi.fn(),
}));
vi.mock("../supervisor/service-child-group-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supervisor/service-child-group-ownership.js")>()),
  readProcessGroupMembers: boundary.census,
  isProcessGroupGoneByCensus: boundary.groupGone,
}));
// A nested PID namespace with the parent's /proc mounted reports another PID for /proc/self.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readlinkSync = ((...args: Parameters<typeof actual.readlinkSync>) =>
    boundary.foreignProcfs ? "1" : actual.readlinkSync(...args)) as typeof actual.readlinkSync;
  return { ...actual, readlinkSync };
});
vi.mock("../kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../kill-tree.js")>()),
  killProcessTree: boundary.killTree,
}));
vi.mock("../../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/pid-alive.js")>()),
  getProcessInstanceStartTime: boundary.identity,
  isPidDefinitelyDead: boundary.dead,
}));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: boundary.delay,
}));
afterEach(() => {
  boundary.foreignProcfs = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.skipIf(process.platform === "win32").each(["owned", "moved-group", "unknown-birth"] as const)(
  "signals only revalidated broker group members (%s)",
  async (mode) => {
    const owner = { pid: process.pid, pgid: process.pid, state: "S" };
    const child = { pid: 123456789, pgid: process.pid, state: "S" };
    boundary.census.mockReturnValueOnce([owner, child]);
    boundary.census.mockReturnValueOnce([
      owner,
      { ...child, pgid: mode === "moved-group" ? 42 : process.pid },
    ]);
    boundary.census.mockReturnValue([owner]);
    boundary.identity.mockReturnValue(mode === "unknown-birth" ? null : 7);
    boundary.dead.mockReturnValue(false);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    if (mode === "unknown-birth") {
      await expect(drainCurrentBrokerProcessGroup()).rejects.toThrow(
        "cannot identify remaining group member",
      );
    } else {
      await drainCurrentBrokerProcessGroup();
    }
    if (mode === "owned") {
      expect(kill).toHaveBeenCalledExactlyOnceWith(child.pid, "SIGTERM");
    } else {
      expect(kill).not.toHaveBeenCalled();
    }
  },
);

it("retires delayed detached escalation when the captured leader is replaced", async () => {
  const pid = 123456789;
  boundary.identity.mockReturnValue(7);
  boundary.dead.mockReturnValue(false);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const cleanup = terminateLostBrokerChild(pid, true, { pid, startedAt: 7 });
  expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-pid, "SIGTERM"]]);
  boundary.identity.mockReturnValue(8);
  cleanup.force();
  await cleanup.settled;
  cleanup.force();
  expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-pid, "SIGTERM"]]);
});

it.each(["gone", "reused", "unavailable"] as const)(
  "never signals a detached group whose original identity is %s",
  async (mode) => {
    const pid = 123456789;
    boundary.identity.mockReturnValue(mode === "unavailable" ? null : 8);
    boundary.dead.mockReturnValue(false);
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0 && mode === "gone") {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });
    const cleanup = terminateLostBrokerChild(pid, true, { pid, startedAt: 7 });
    if (mode === "unavailable") {
      await expect(cleanup.settled).rejects.toThrow("identity is unavailable");
    } else {
      await cleanup.settled;
    }
    cleanup.force();
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  },
);

it.skipIf(process.platform === "win32").each([-60_000, 60_000])(
  "preserves the cleanup grace period after a %i ms wall-clock step",
  async (step) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    boundary.delay.mockImplementation(
      (ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
    );
    const owner = { pid: process.pid, pgid: process.pid, state: "S" };
    const child = { pid: 123456789, pgid: process.pid, state: "S" };
    boundary.census.mockReturnValue([owner, child]);
    boundary.identity.mockReturnValue(7);
    boundary.dead.mockReturnValue(false);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const settled = drainCurrentBrokerProcessGroup();
    try {
      vi.setSystemTime(Date.now() + step);
      await vi.advanceTimersByTimeAsync(GRACEFUL_CANCEL_TIMEOUT_MS - 1);
      expect(kill).toHaveBeenCalledExactlyOnceWith(child.pid, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1);
      expect(kill).toHaveBeenCalledWith(child.pid, "SIGKILL");
    } finally {
      boundary.census.mockReturnValue([owner]);
      await vi.advanceTimersByTimeAsync(50);
      await settled;
    }
  },
);

describe.skipIf(process.platform !== "linux")("denied negative-PID signals", () => {
  const pgid = 123456789;
  // The impossible group the denial canary signals: the kernel answers it with ESRCH.
  const canaryGroup = -(4_194_304 + 1);
  const deadlineMs = GRACEFUL_CANCEL_TIMEOUT_MS + 2_100;
  const errno = (code: string) =>
    Object.assign(new Error(`kill ${code}`), { code, syscall: "kill" });
  const settle = (settled: Promise<void>) =>
    settled.then(
      () => "settled" as const,
      (error: unknown) => error,
    );
  const memberSignals = (kill: { mock: { calls: Parameters<typeof process.kill>[] } }) =>
    kill.mock.calls.filter(([target, signal]) => target > 0 && signal !== 0);

  // One process table backs the census reader and the extinction predicate, as /proc does.
  function useProcessTable(pids: number[], afterRead?: () => void) {
    const live = new Set(pids);
    boundary.census.mockImplementation(() => {
      afterRead?.();
      return [
        { pid: process.pid, pgid: 1, state: "S" },
        ...[...live].map((pid) => ({ pid, pgid, state: "S" })),
      ];
    });
    boundary.dead.mockImplementation((pid: number) => !live.has(pid));
    boundary.groupGone.mockImplementation(() => live.size === 0);
    boundary.identity.mockReturnValue(7);
    return live;
  }

  function denyGroupSignals(onSignal: (pid: number, signal?: string | number) => void) {
    return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0) {
        throw errno("EPERM");
      }
      onSignal(pid, signal);
      return true;
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    boundary.delay.mockImplementation(
      (ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
    );
  });

  it("signals every member when one member signal fails, then surfaces the failure", async () => {
    const live = useProcessTable([111, 222]);
    const kill = denyGroupSignals((pid) => {
      if (pid === 111) {
        throw errno("EPERM");
      }
      live.delete(pid);
    });
    const outcome = settle(terminateBrokerProcessGroup(pgid).settled);
    await vi.advanceTimersByTimeAsync(deadlineMs);
    // A kernel group kill reaches every signalable member, so one refusal must not skip the rest.
    expect(memberSignals(kill)).toContainEqual([222, "SIGTERM"]);
    expect(await outcome).toMatchObject({ cause: { code: "EPERM", syscall: "kill" } });
  });

  it("classifies a denial with the signal that failed, not with signal 0", async () => {
    const live = useProcessTable([111]);
    // A filter that allows probes but denies real group signals, canary included.
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === canaryGroup && signal === 0) {
        throw errno("ESRCH");
      }
      if (pid < 0 && signal !== 0) {
        throw errno("EPERM");
      }
      if (pid > 0) {
        live.delete(pid);
      } else if (!live.size) {
        throw errno("ESRCH");
      }
      return true;
    });
    const outcome = settle(terminateBrokerProcessGroup(pgid).settled);
    await vi.advanceTimersByTimeAsync(deadlineMs);
    expect(await outcome).toBe("settled");
    expect(memberSignals(kill)).toEqual([[111, "SIGTERM"]]);
  });

  it("escalates a retained detached group by PID and kills members that join later", async () => {
    const live = useProcessTable([pgid]);
    const kill = denyGroupSignals((pid, signal) => {
      if (pid === pgid + 1 && signal === "SIGKILL") {
        // The leader ignores SIGTERM; the group only empties once the late joiner is killed.
        live.clear();
      }
    });
    const outcome = settle(
      terminateLostBrokerChild(pgid, true, { pid: pgid, startedAt: 7 }).settled,
    );
    await vi.advanceTimersByTimeAsync(GRACEFUL_CANCEL_TIMEOUT_MS);
    live.add(pgid + 1);
    await vi.advanceTimersByTimeAsync(deadlineMs);
    expect(await outcome).toBe("settled");
    // Each member is signaled once per phase, however many ticks repeat it.
    expect(memberSignals(kill)).toEqual([
      [pgid, "SIGTERM"],
      [pgid, "SIGKILL"],
      [pgid + 1, "SIGKILL"],
    ]);
  });

  it("keeps retained cleanup running to its deadline through a census failure", async () => {
    const unavailable = new Error("census unavailable");
    useProcessTable([pgid], () => {
      throw unavailable;
    });
    const kill = denyGroupSignals(() => {});
    const outcome = settle(
      terminateLostBrokerChild(pgid, true, { pid: pgid, startedAt: 7 }).settled,
    );
    await vi.advanceTimersByTimeAsync(GRACEFUL_CANCEL_TIMEOUT_MS);
    // Like the private group, the retained group keeps ticking and still sends SIGKILL after the grace.
    expect(kill).toHaveBeenCalledWith(-pgid, "SIGKILL");
    await vi.advanceTimersByTimeAsync(deadlineMs);
    // An unreadable process table is never treated as an empty group, and nothing is signaled blind.
    expect(await outcome).toMatchObject({ cause: unavailable });
    expect(memberSignals(kill)).toEqual([]);
  });

  it("signals no member when /proc belongs to another PID namespace", async () => {
    useProcessTable([111]);
    boundary.foreignProcfs = true;
    const kill = denyGroupSignals(() => {});
    const retained = settle(
      terminateLostBrokerChild(pgid, true, { pid: pgid, startedAt: 7 }).settled,
    );
    const privateGroup = settle(terminateBrokerProcessGroup(pgid).settled);
    await vi.advanceTimersByTimeAsync(deadlineMs);
    const cause = { message: expect.stringContaining("PID namespace") };
    expect(await retained).toMatchObject({ cause });
    expect(await privateGroup).toMatchObject({ cause });
    expect(memberSignals(kill)).toEqual([]);
  });

  it("confirms a lost detached child without identity from the census", async () => {
    const exited = vi.fn(() => false);
    boundary.killTree.mockReturnValue({ exited, force: vi.fn() });
    useProcessTable([]);
    denyGroupSignals(() => {});
    const outcome = settle(terminateLostBrokerChild(pgid, true).settled);
    await vi.advanceTimersByTimeAsync(deadlineMs);
    // The agent-core wait still reports the group alive, but the group owner proves it gone.
    expect(await outcome).toBe("settled");
    expect(exited).toHaveBeenCalled();
  });
});
