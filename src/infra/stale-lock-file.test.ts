import { describe, expect, it } from "vitest";
import { shouldRemoveDeadOwnerOrExpiredLock } from "./stale-lock-file.js";

describe("stale lock file ownership", () => {
  it("keeps lock when owner pid probe is inconclusive and createdAt is still fresh", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: new Date(Date.now() - 5).toISOString(),
        },
        staleMs: 10_000,
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(false);
  });

  it("removes lock when the recorded owner is definitely dead", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: new Date(Date.now() - 5).toISOString(),
        },
        staleMs: 10_000,
        isPidDefinitelyDead: () => true,
      }),
    ).toBe(true);
  });

  it("removes lock when createdAt is older than staleMs even if the recorded pid is currently alive (pid reuse safeguard)", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 12345,
          createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
        },
        staleMs: 60 * 60 * 1000,
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(true);
  });

  it("removes lock when createdAt is unparseable", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: 12345, createdAt: "not-a-date" },
        staleMs: 1_000,
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(true);
  });

  it("falls back to pid liveness when payload has no createdAt", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: 12345 },
        staleMs: 1_000,
        isPidDefinitelyDead: () => true,
      }),
    ).toBe(true);
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: 12345 },
        staleMs: 1_000,
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(false);
  });

  it("keeps lock with no pid and fresh createdAt", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { createdAt: new Date(Date.now() - 5).toISOString() },
        staleMs: 10_000,
      }),
    ).toBe(false);
  });

  it("removes lock with no pid when createdAt is older than staleMs", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { createdAt: new Date(Date.now() - 60_000).toISOString() },
        staleMs: 1_000,
      }),
    ).toBe(true);
  });

  it("returns false for null payload", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: null,
        staleMs: 10,
      }),
    ).toBe(false);
  });

  it("honors injected nowMs when comparing createdAt against staleMs", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const fixedNow = Date.parse(createdAt) + 2_000;
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: 12345, createdAt },
        staleMs: 1_000,
        nowMs: fixedNow,
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(true);
  });
});
