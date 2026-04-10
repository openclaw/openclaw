// Octopus Orchestrator — LeaseService tests (M4-01)
//
// Covers: issue, renew, expireStale, get, isExpired, getGraceWindowMs,
// event emission on renew and expire.
//
// Each test gets a fresh temp SQLite DB + event log via beforeEach/afterEach.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OctoLeaseConfig } from "../config/schema.ts";
import { EventLogService } from "./event-log.ts";
import { LeaseService } from "./leases.ts";
import { closeOctoRegistry, openOctoRegistry } from "./storage/migrate.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB + event log harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let eventLog: EventLogService;
let leaseService: LeaseService;
let eventsPath: string;

const DEFAULT_LEASE_CONFIG: OctoLeaseConfig = {
  renewIntervalS: 10,
  ttlS: 30,
  graceS: 30,
  sideEffectingGraceS: 60,
};

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-leases-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  eventsPath = path.join(tempDir, "events.jsonl");
  eventLog = new EventLogService({ path: eventsPath });
  leaseService = new LeaseService(db, eventLog, DEFAULT_LEASE_CONFIG);
});

afterEach(() => {
  try {
    closeOctoRegistry(db);
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
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

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("LeaseService", () => {
  // 1. issue creates a lease with correct fields
  it("issue creates lease with default TTL", async () => {
    const lease = await leaseService.issue("arm-1", "node-1");
    expect(lease.arm_id).toBe("arm-1");
    expect(lease.node_id).toBe("node-1");
    expect(lease.lease_owner).toBe("arm-1");
    expect(lease.version).toBe(0);
    // expires_at should be approximately now + 30s (default ttlS)
    const expectedExpiry = Date.now() + 30_000;
    expect(lease.expires_at).toBeGreaterThan(expectedExpiry - 2000);
    expect(lease.expires_at).toBeLessThanOrEqual(expectedExpiry + 1000);
  });

  // 2. issue with custom TTL
  it("issue respects custom ttlMs", async () => {
    const lease = await leaseService.issue("arm-2", "node-1", 5000);
    const expectedExpiry = Date.now() + 5000;
    expect(lease.expires_at).toBeGreaterThan(expectedExpiry - 2000);
    expect(lease.expires_at).toBeLessThanOrEqual(expectedExpiry + 1000);
  });

  // 3. renew extends expires_at and bumps version
  it("renew extends lease and bumps version", async () => {
    const original = await leaseService.issue("arm-1", "node-1", 5000);
    expect(original.version).toBe(0);

    const renewed = await leaseService.renew("arm-1");
    expect(renewed.version).toBe(1);
    // renewed expires_at should be > original expires_at (default extension = ttlS * 1000 = 30s)
    expect(renewed.expires_at).toBeGreaterThan(original.expires_at);
    expect(renewed.renewed_at).toBeGreaterThanOrEqual(original.renewed_at);
  });

  // 4. renew with custom extension
  it("renew respects custom extensionMs", async () => {
    await leaseService.issue("arm-1", "node-1", 5000);
    const renewed = await leaseService.renew("arm-1", 60_000);
    const expectedExpiry = Date.now() + 60_000;
    expect(renewed.expires_at).toBeGreaterThan(expectedExpiry - 2000);
    expect(renewed.expires_at).toBeLessThanOrEqual(expectedExpiry + 1000);
  });

  // 5. expireStale removes stale leases
  it("expireStale removes expired leases", async () => {
    await leaseService.issue("arm-1", "node-1", 1000);
    await leaseService.issue("arm-2", "node-2", 1000);
    await leaseService.issue("arm-3", "node-3", 100_000);

    // Expire with a future timestamp that makes arm-1 and arm-2 stale
    const futureNow = Date.now() + 5000;
    const result = await leaseService.expireStale(futureNow);

    expect(result.count).toBe(2);
    expect(result.expired).toContain("arm-1");
    expect(result.expired).toContain("arm-2");
    expect(result.expired).not.toContain("arm-3");

    // Verify deleted from DB
    expect(leaseService.get("arm-1")).toBeNull();
    expect(leaseService.get("arm-2")).toBeNull();
    expect(leaseService.get("arm-3")).not.toBeNull();
  });

  // 6. get returns null for missing lease
  it("get returns null for non-existent arm_id", () => {
    expect(leaseService.get("arm-nonexistent")).toBeNull();
  });

  // 7. isExpired is correct
  it("isExpired returns true for expired and missing leases", async () => {
    // Missing lease -> expired
    expect(leaseService.isExpired("arm-missing")).toBe(true);

    // Active lease -> not expired
    await leaseService.issue("arm-1", "node-1", 30_000);
    expect(leaseService.isExpired("arm-1")).toBe(false);

    // Check with future timestamp -> expired
    const futureNow = Date.now() + 60_000;
    expect(leaseService.isExpired("arm-1", futureNow)).toBe(true);
  });

  // 8. renew emits lease.renewed event
  it("renew emits lease.renewed event", async () => {
    await leaseService.issue("arm-1", "node-1");
    await leaseService.renew("arm-1");

    const events = readEvents();
    const renewedEvents = events.filter((e) => e.event_type === "lease.renewed");
    expect(renewedEvents).toHaveLength(1);
    expect(renewedEvents[0].entity_type).toBe("lease");
    expect(renewedEvents[0].entity_id).toBe("arm-1");
    const payload = renewedEvents[0].payload as Record<string, unknown>;
    expect(payload.arm_id).toBe("arm-1");
    expect(payload.node_id).toBe("node-1");
  });

  // 9. expireStale emits lease.expired events
  it("expireStale emits lease.expired events for each expired lease", async () => {
    await leaseService.issue("arm-1", "node-1", 1000);
    await leaseService.issue("arm-2", "node-2", 1000);

    const futureNow = Date.now() + 5000;
    await leaseService.expireStale(futureNow);

    const events = readEvents();
    const expiredEvents = events.filter((e) => e.event_type === "lease.expired");
    expect(expiredEvents).toHaveLength(2);

    const armIds = expiredEvents.map((e) => (e.payload as Record<string, unknown>).arm_id);
    expect(armIds).toContain("arm-1");
    expect(armIds).toContain("arm-2");
  });

  // 10. grace window differentiation
  it("getGraceWindowMs differentiates side-effecting vs non-side-effecting", () => {
    expect(leaseService.getGraceWindowMs(false)).toBe(30_000); // graceS * 1000
    expect(leaseService.getGraceWindowMs(true)).toBe(60_000); // sideEffectingGraceS * 1000
  });

  // 11. renew throws for missing lease
  it("renew throws when lease does not exist", async () => {
    await expect(leaseService.renew("arm-nonexistent")).rejects.toThrow(
      "no lease found for arm arm-nonexistent",
    );
  });
});
