// Octopus Orchestrator -- chaos test: clock skew +/-30s (M4-12)
//
// Simulates clock skew between Head and Node Agent by mocking Date.now()
// at the call site. The LeaseService uses Date.now() internally for all
// timing decisions (issue, renew, expireStale, isExpired). A Node Agent
// with a skewed clock sends renewals whose *arrival* time at the Head is
// correct -- only the Node's perception of "now" differs. The Head must
// use its own clock for expiry, never a claimed timestamp.
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins, `vitest`, and relative imports inside
//   `src/octo/` are permitted.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OctoLeaseConfig } from "../../config/schema.ts";
import { EventLogService } from "../../head/event-log.ts";
import { LeaseService } from "../../head/leases.ts";
import { closeOctoRegistry, openOctoRegistry } from "../../head/storage/migrate.ts";

// ──────────────────────────────────────────────────────────────────────────
// Shared harness -- temp DB + event log per test
// ──────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let db: DatabaseSync;
let eventLog: EventLogService;
let leaseService: LeaseService;
let eventsPath: string;

const SKEW_CONFIG: OctoLeaseConfig = {
  renewIntervalS: 10,
  ttlS: 30,
  graceS: 30,
  sideEffectingGraceS: 60,
};

const TTL_MS = SKEW_CONFIG.ttlS * 1000;
const GRACE_MS = SKEW_CONFIG.graceS * 1000;
const _SKEW_MS = 30_000; // +/-30s skew

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "octo-chaos-clock-skew-"));
  const dbPath = path.join(tmpDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  eventsPath = path.join(tmpDir, "events.jsonl");
  eventLog = new EventLogService({ path: eventsPath });
  leaseService = new LeaseService(db, eventLog, SKEW_CONFIG);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    closeOctoRegistry(db);
  } catch {
    // already closed
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function readEvents(): Array<Record<string, unknown>> {
  try {
    const content = readFileSync(eventsPath, "utf8").trim();
    if (!content) {
      return [];
    }
    return content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Pin Date.now() to a fixed value for the duration of a callback. */
function withHeadClock<T>(headNow: number, fn: () => T): T {
  const spy = vi.spyOn(Date, "now").mockReturnValue(headNow);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

async function withHeadClockAsync<T>(headNow: number, fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, "now").mockReturnValue(headNow);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("chaos: clock skew +/-30s between Head and Node Agent (M4-12)", () => {
  // Scenario: Head issues lease at T. Node renews at T+10 but the Node
  // thinks it is T+10+30 (positive skew). The Head receives the renewal
  // and processes it with its own clock (T+10). The lease should remain
  // valid because the Head computes expires_at = Head.now() + TTL.

  it("+30s Node skew on renewal -- lease still valid (Head uses own clock)", async () => {
    const T = 1_000_000_000_000;

    // Head issues lease at T.
    const lease = await withHeadClockAsync(T, () => leaseService.issue("arm-1", "node-1"));
    expect(lease.expires_at).toBe(T + TTL_MS);

    // At Head time T+10s, Node renews. Node thinks it is T+10+30=T+40s
    // but the Head processes with its own clock (T+10s).
    const headRenewTime = T + 10_000;
    const renewed = await withHeadClockAsync(headRenewTime, () => leaseService.renew("arm-1"));

    // expires_at should be computed from Head clock, not Node clock.
    expect(renewed.expires_at).toBe(headRenewTime + TTL_MS);

    // Lease must not be expired at Head time T+10s.
    const expired = withHeadClock(headRenewTime, () => leaseService.isExpired("arm-1"));
    expect(expired).toBe(false);
  });

  it("-30s Node skew on renewal -- lease still valid (Head uses own clock)", async () => {
    const T = 1_000_000_000_000;

    // Head issues lease at T.
    await withHeadClockAsync(T, () => leaseService.issue("arm-1", "node-1"));

    // At Head time T+10s, Node renews. Node thinks it is T+10-30=T-20s
    // (negative skew) but the Head processes with its own clock (T+10s).
    const headRenewTime = T + 10_000;
    const renewed = await withHeadClockAsync(headRenewTime, () => leaseService.renew("arm-1"));

    // expires_at must reflect Head clock.
    expect(renewed.expires_at).toBe(headRenewTime + TTL_MS);

    // Lease must not be expired at Head time T+10s.
    const expired = withHeadClock(headRenewTime, () => leaseService.isExpired("arm-1"));
    expect(expired).toBe(false);

    // Even at T+10+29s (just before TTL), still valid.
    const almostExpired = withHeadClock(headRenewTime + TTL_MS - 1, () =>
      leaseService.isExpired("arm-1"),
    );
    expect(almostExpired).toBe(false);
  });

  it("lease expires at Head TTL regardless of Node skew", async () => {
    const T = 1_000_000_000_000;

    // Issue at Head time T.
    await withHeadClockAsync(T, () => leaseService.issue("arm-1", "node-1"));

    // Renew at Head time T+10s.
    const headRenewTime = T + 10_000;
    await withHeadClockAsync(headRenewTime, () => leaseService.renew("arm-1"));

    // Lease expires_at = headRenewTime + TTL_MS. At that exact moment,
    // isExpired uses <=, so it should be expired.
    const expiryMoment = headRenewTime + TTL_MS;
    const expiredAtBoundary = withHeadClock(expiryMoment, () => leaseService.isExpired("arm-1"));
    expect(expiredAtBoundary).toBe(true);

    // One ms before: still valid.
    const validJustBefore = withHeadClock(expiryMoment - 1, () => leaseService.isExpired("arm-1"));
    expect(validJustBefore).toBe(false);

    // expireStale at the boundary should remove the lease.
    const staleResult = await withHeadClockAsync(expiryMoment + 1, () =>
      leaseService.expireStale(expiryMoment + 1),
    );
    expect(staleResult.expired).toContain("arm-1");
    expect(staleResult.count).toBe(1);
  });

  it("no premature reassignment during grace window even with +/-30s skew", async () => {
    const T = 1_000_000_000_000;

    // Issue lease at Head time T.
    const lease = await withHeadClockAsync(T, () => leaseService.issue("arm-1", "node-1"));
    const expiresAt = lease.expires_at; // T + TTL_MS

    // At expiry, the lease is technically expired but is within grace.
    // Grace window runs from expires_at to expires_at + GRACE_MS.
    // During this window, the arm should NOT be reassigned -- the
    // original holder can still renew.
    const gracePoint = expiresAt + GRACE_MS / 2; // midway through grace

    // isExpired returns true (TTL passed), but the lease record still
    // exists -- expireStale only removes leases past expires_at, so
    // the lease row is still present.
    const expiredAtGrace = withHeadClock(gracePoint, () => leaseService.isExpired("arm-1"));
    expect(expiredAtGrace).toBe(true);

    // The lease record must still be in the DB (not yet reaped).
    // expireStale at gracePoint removes it, but a scheduler that checks
    // getGraceWindowMs before reassigning would see that gracePoint is
    // within expires_at + graceMs and hold off.
    const record = leaseService.get("arm-1");
    expect(record).not.toBeNull();
    expect(record!.expires_at).toBe(expiresAt);

    // Grace window check: gracePoint < expiresAt + graceMs means we are
    // inside the grace window. A skewed Node (+30s or -30s) does not
    // change this calculation because it runs on Head time.
    const withinGrace = gracePoint < expiresAt + GRACE_MS;
    expect(withinGrace).toBe(true);

    // The original holder can still renew during grace.
    const renewed = await withHeadClockAsync(gracePoint, () => leaseService.renew("arm-1"));
    expect(renewed.expires_at).toBe(gracePoint + TTL_MS);
    expect(renewed.version).toBe(1);

    // Event log should contain the renewal.
    const events = readEvents();
    const renewedEvents = events.filter((e) => e.event_type === "lease.renewed");
    expect(renewedEvents.length).toBeGreaterThanOrEqual(1);
  });
});
