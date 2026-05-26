import { describe, expect, it } from "vitest";
import { shouldRemoveDeadOwnerOrExpiredLock } from "./stale-lock-file.js";

describe("stale lock file ownership", () => {
  it("treats permission-denied process probes as not definitely dead", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: new Date(Date.now() - 5).toISOString(),
        },
        staleMs: 10,
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(false);
  });

  it("only removes pid-owned locks when the owner is definitely dead", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: new Date(Date.now() - 5).toISOString(),
        },
        staleMs: 10,
        isPidDefinitelyDead: () => true,
      }),
    ).toBe(true);
  });

  it("removes expired locks even when PID is alive (reused PID case)", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 12345,
          createdAt: "2026-05-23T00:00:00.000Z",
        },
        staleMs: 10,
        nowMs: Date.parse("2026-05-23T00:00:01.000Z"),
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(true);
  });
});
