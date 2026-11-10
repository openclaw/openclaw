// Covers stale lock-file owner decisions.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pidAlive from "../shared/pid-alive.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  inspectStaleLockOwner,
  isLockOwnerDefinitelyStale,
  shouldRemoveDeadOwnerOrExpiredLock,
} from "./stale-lock-file.js";

describe("stale lock file ownership", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    { dead: true, start: 111, reason: "owner-process-exited", reads: 0 },
    { dead: false, start: 111, reason: null, reads: 1 },
    { dead: false, start: 222, reason: "owner-starttime-changed", reads: 1 },
    { dead: false, start: null, reason: null, reads: 1 },
  ])(
    "inspects owner death=$dead start=$start without redundant probes",
    ({ dead, start, reason, reads }) => {
      const probe = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(start);
      const liveness = vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(dead);
      const observed = inspectStaleLockOwner({
        payload: { pid: 123, starttime: 111, privateField: "must-not-be-copied" },
      });
      expect(observed).toEqual(
        reason
          ? {
              reason,
              pid: 123,
              recordedStarttime: 111,
              observedStarttime: dead ? null : start,
            }
          : null,
      );
      expect(probe).toHaveBeenCalledTimes(reads);
      expect(liveness).toHaveBeenCalledExactlyOnceWith(123);
    },
  );

  it("keeps expired locks when a pid owner is not definitely dead", () => {
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    expect(
      isLockOwnerDefinitelyStale({
        payload: { pid: 123, createdAt: "2026-05-23T00:00:00.000Z" },
      }),
    ).toBe(false);
  });

  it("retains shipped expiry recovery for generic pidless locks", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { createdAt: "2026-05-23T00:00:00.000Z" },
        staleMs: 10,
        nowMs: Date.parse("2026-05-23T00:00:11.000Z"),
      }),
    ).toBe(true);
  });

  it("keeps malformed locks", () => {
    expect(isLockOwnerDefinitelyStale({ payload: null })).toBe(false);
  });

  it("accepts legacy Darwin microsecond start times", async () => {
    await withMockedPlatform("darwin", async () => {
      vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
      vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(1_752_000_000);
      expect(
        isLockOwnerDefinitelyStale({
          payload: { pid: 123, starttime: 1_752_000_000_123_456 },
        }),
      ).toBe(false);
    });
  });
});
