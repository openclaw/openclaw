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
  it("records the deciding exited-owner facts without payload disclosure", () => {
    let startReads = 0;
    let deadReads = 0;
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation(() => {
      startReads += 1;
      return 111;
    });
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockImplementation(() => {
      deadReads += 1;
      return true;
    });
    const observed = inspectStaleLockOwner({
      payload: { pid: 123, starttime: 111, privateField: "must-not-be-copied" },
    });
    expect(observed).toEqual({
      reason: "owner-process-exited",
      pid: 123,
      recordedStarttime: 111,
      observedStarttime: 111,
    });
    expect(startReads).toBe(1);
    expect(deadReads).toBe(1);
  });

  it("keeps expired locks when a pid owner is not definitely dead", () => {
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    expect(
      isLockOwnerDefinitelyStale({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("classifies locks when the owner pid starttime changed", () => {
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(222);
    expect(
      isLockOwnerDefinitelyStale({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
          starttime: 111,
        },
      }),
    ).toBe(true);
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
    expect(
      isLockOwnerDefinitelyStale({
        payload: null,
      }),
    ).toBe(false);
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
