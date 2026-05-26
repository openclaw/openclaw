import { describe, expect, it } from "vitest";
import { shouldRemoveDeadOwnerOrExpiredLock } from "./stale-lock-file.js";

describe("stale lock file ownership", () => {
  it("removes expired locks before trusting pid liveness", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
        },
        staleMs: 10,
        nowMs: Date.parse("2026-05-23T00:00:11.000Z"),
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(true);
  });

  it("treats permission-denied process probes as alive for non-expired locks", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
        },
        staleMs: 60_000,
        nowMs: Date.parse("2026-05-23T00:00:10.000Z"),
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(false);
  });

  it("only removes pid-owned locks when the owner is definitely dead", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
        staleMs: 10,
        isPidDefinitelyDead: () => true,
      }),
    ).toBe(true);
  });
});
