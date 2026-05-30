import { describe, expect, it } from "vitest";
import { shouldRemoveDeadOwnerOrExpiredLock } from "./stale-lock-file.js";

describe("shouldRemoveDeadOwnerOrExpiredLock", () => {
  it("removes an expired lock without owner metadata", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { createdAt: past },
        staleMs: 1_000,
      }),
    ).toBe(true);
  });

  it("keeps a fresh lock without owner metadata", () => {
    const nowIso = new Date().toISOString();
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { createdAt: nowIso },
        staleMs: 1_000,
      }),
    ).toBe(false);
  });

  it("removes a lock whose owner pid is definitely dead", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: 4242, createdAt: new Date().toISOString() },
        staleMs: 1_000,
        isPidDefinitelyDead: () => true,
      }),
    ).toBe(true);
  });

  it("keeps a lock whose owner pid is alive even when older than staleMs (legacy, no startTime)", () => {
    // Preserves the pre-existing semantics: a live PID's lock is never stolen
    // when the lock predates the startTime field.
    const old = new Date(Date.now() - 60_000).toISOString();
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: process.pid, createdAt: old },
        staleMs: 1_000,
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(false);
  });

  it("removes a lock when the owner pid is alive but its start time was recycled", () => {
    // Container case: PID 2 is alive after a restart, but it is a new process
    // (different start time) than the one that wrote the lock.
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: 2, createdAt: new Date().toISOString(), startTime: 111 },
        staleMs: 5 * 60_000,
        isPidDefinitelyDead: () => false,
        getProcessStartTime: () => 999,
      }),
    ).toBe(true);
  });

  it("keeps a lock when the owner pid is alive and its start time still matches", () => {
    // A genuinely long-running holder (e.g. a slow snapshot dump) must not have
    // its lock reclaimed out from under it.
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: 2, createdAt: new Date(Date.now() - 60_000).toISOString(), startTime: 555 },
        staleMs: 1_000,
        isPidDefinitelyDead: () => false,
        getProcessStartTime: () => 555,
      }),
    ).toBe(false);
  });

  it("keeps a lock when the owner start time cannot be read (non-Linux / unreadable)", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { pid: 2, createdAt: new Date().toISOString(), startTime: 555 },
        staleMs: 1_000,
        isPidDefinitelyDead: () => false,
        getProcessStartTime: () => null,
      }),
    ).toBe(false);
  });
});
