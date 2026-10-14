import { afterEach, expect, it, vi } from "vitest";
import { drainCurrentBrokerProcessGroup, terminateLostBrokerChild } from "./cleanup.js";

const boundary = vi.hoisted(() => ({ census: vi.fn(), identity: vi.fn(), dead: vi.fn() }));
vi.mock("../supervisor/service-child-group-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supervisor/service-child-group-ownership.js")>()),
  readProcessGroupMembers: boundary.census,
}));
vi.mock("../../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/pid-alive.js")>()),
  getProcessInstanceStartTime: boundary.identity,
  isPidDefinitelyDead: boundary.dead,
}));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
afterEach(() => {
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
  const cleanup = terminateLostBrokerChild(pid, true, undefined, { pid, startedAt: 7 });
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
    const cleanup = terminateLostBrokerChild(pid, true, undefined, { pid, startedAt: 7 });
    if (mode === "unavailable") {
      await expect(cleanup.settled).rejects.toThrow("identity is unavailable");
    } else {
      await cleanup.settled;
    }
    cleanup.force();
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  },
);
