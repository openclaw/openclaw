import { afterEach, expect, it, vi } from "vitest";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { drainCurrentBrokerProcessGroup, terminateLostBrokerChild } from "./cleanup.js";

const boundary = vi.hoisted(() => ({
  census: vi.fn(),
  identity: vi.fn(),
  dead: vi.fn(),
  delay: vi.fn(),
}));
vi.mock("../supervisor/service-child-group-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supervisor/service-child-group-ownership.js")>()),
  readProcessGroupMembers: boundary.census,
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
