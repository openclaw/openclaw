import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const mocks = vi.hoisted(() => ({
  starts: new Map<number, number>(),
  kill: vi.fn<typeof process.kill>(),
  readOwner: vi.fn<typeof import("./gateway-owner-lease.js").readGatewayOwnerLease>(),
  sleep: vi.fn<() => Promise<void>>(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));
vi.mock("./gateway-owner-lease.js", () => ({ readGatewayOwnerLease: mocks.readOwner }));
vi.mock("../shared/pid-alive.js", () => ({
  getFileLockProcessStartTime: (pid: number) => mocks.starts.get(pid) ?? null,
  isPidDefinitelyDead: (pid: number) => !mocks.starts.has(pid),
}));
vi.mock("../utils/sleep.js", () => ({ sleep: mocks.sleep }));

import { terminateStaleGatewayPids } from "./restart-stale-pids.js";

describe("stale Gateway process-group escalation", () => {
  const leader = 5760;
  const child = 5761;
  const unrelated = 5762;

  beforeEach(() => {
    mocks.starts.clear();
    mocks.starts.set(leader, 1000);
    mocks.starts.set(child, 1001);
    mocks.starts.set(unrelated, 1002);
    mocks.readOwner.mockReset();
    mocks.readOwner.mockReturnValue(undefined);
    mocks.sleep.mockReset();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.spawnSync.mockReset();
    mocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "ps" && args[0] === "-p") {
        return { status: 0, stdout: `${leader}\n` };
      }
      if (command === "ps" && args[0] === "-axo") {
        return { status: 0, stdout: `${leader} ${leader}\n${child} ${leader}\n${unrelated} 1\n` };
      }
      throw new Error(`Unexpected process command: ${command}`);
    });
    mocks.kill.mockReset().mockImplementation((pid, signal) => {
      if (pid === -leader && signal === "SIGTERM") {
        // The child ignores TERM, and becomes reparented when the leader exits.
        mocks.starts.delete(leader);
      } else if (signal === "SIGKILL") {
        mocks.starts.delete(pid);
      }
      return true;
    });
    vi.spyOn(process, "kill").mockImplementation(mocks.kill);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kills a surviving child after the group leader exits on SIGTERM", async () => {
    await withMockedPlatform("darwin", async () => {
      expect(await terminateStaleGatewayPids([leader])).toEqual([leader]);
      expect(mocks.starts.has(leader)).toBe(false);
      expect(mocks.starts.has(child)).toBe(false);
      expect(mocks.starts.has(unrelated)).toBe(true);
      expect(mocks.kill).toHaveBeenCalledWith(child, "SIGKILL");
    });
  });

  it("does not adopt a child PID recycled outside the group during identity capture", async () => {
    let snapshots = 0;
    mocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "ps" && args[0] === "-p") {
        return { status: 0, stdout: `${leader}\n` };
      }
      if (command === "ps" && args[0] === "-axo") {
        snapshots += 1;
        mocks.starts.set(child, 2000);
        return {
          status: 0,
          stdout: `${leader} ${leader}\n${child} ${snapshots === 1 ? leader : 1}\n`,
        };
      }
      throw new Error(`Unexpected process command: ${command}`);
    });
    await withMockedPlatform("darwin", async () => {
      expect(await terminateStaleGatewayPids([leader])).toEqual([leader]);
      expect(mocks.starts.get(child)).toBe(2000);
      expect(mocks.kill).not.toHaveBeenCalledWith(child, "SIGKILL");
    });
  });

  it.each(["recycled-child", "replacement-owner"])(
    "preserves a captured child after %s appears during the TERM grace period",
    async (replacement) => {
      mocks.sleep.mockImplementation(async () => {
        if (replacement === "recycled-child") {
          mocks.starts.set(child, 2000);
        } else {
          mocks.readOwner.mockReturnValue({
            owner: "replacement-owner",
            pid: unrelated,
            host: "gateway-test-host",
            startedAt: 1002,
            port: 18789,
            mode: "foreground",
            supervisor: null,
            state: "live",
            expired: false,
          });
        }
      });
      await withMockedPlatform("darwin", async () => {
        expect(await terminateStaleGatewayPids([leader])).toEqual([leader]);
        expect(mocks.starts.has(child)).toBe(true);
        expect(mocks.kill).not.toHaveBeenCalledWith(child, "SIGKILL");
      });
    },
  );
});
