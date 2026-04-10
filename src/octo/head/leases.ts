// Octopus Orchestrator — LeaseService (M4-01)
//
// Manages arm leases: issue, renew, expire stale, grace window logic.
//
// Context docs:
//   - LLD §Lease Algorithm — TTL, grace windows, renewal cadence
//   - LLD §Storage Choices — leases table as projection of arm lease state
//   - DECISIONS.md OCTO-DEC-007 — lease windows (side-effecting vs not)
//   - DECISIONS.md OCTO-DEC-010 — SQLite for MVP storage
//   - DECISIONS.md OCTO-DEC-033 — boundary discipline (only src/octo/ imports)
//
// Grace window differentiation:
//   Non-side-effecting grips get config.graceS * 1000 ms (safe to retry).
//   Side-effecting grips get config.sideEffectingGraceS * 1000 ms (longer
//   to reduce duplicate-effect risk during hand-offs).

import type { DatabaseSync } from "node:sqlite";
import type { OctoLeaseConfig } from "../config/schema.ts";
import type { EventLogService } from "./event-log.ts";

// ──────────────────────────────────────────────────────────────────────────
// LeaseRecord — mirrors the `leases` table shape
// ──────────────────────────────────────────────────────────────────────────

export interface LeaseRecord {
  arm_id: string;
  node_id: string;
  lease_owner: string;
  expires_at: number;
  renewed_at: number;
  created_at: number;
  updated_at: number;
  version: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Row type for SQLite result mapping
// ──────────────────────────────────────────────────────────────────────────

interface LeaseRow {
  arm_id: string;
  node_id: string;
  lease_owner: string;
  expires_at: number | bigint;
  renewed_at: number | bigint;
  created_at: number | bigint;
  updated_at: number | bigint;
  version: number | bigint;
}

function rowToRecord(row: LeaseRow): LeaseRecord {
  return {
    arm_id: row.arm_id,
    node_id: row.node_id,
    lease_owner: row.lease_owner,
    expires_at: Number(row.expires_at),
    renewed_at: Number(row.renewed_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    version: Number(row.version),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// LeaseService
// ──────────────────────────────────────────────────────────────────────────

export class LeaseService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly eventLog: EventLogService,
    private readonly config: OctoLeaseConfig,
  ) {}

  /**
   * Issue a new lease for an arm. Inserts into the leases table with
   * expires_at = now + ttlMs (default from config.ttlS * 1000).
   */
  async issue(armId: string, nodeId: string, ttlMs?: number): Promise<LeaseRecord> {
    const now = Date.now();
    const effectiveTtl = ttlMs ?? this.config.ttlS * 1000;
    const expiresAt = now + effectiveTtl;

    const stmt = this.db.prepare(
      "INSERT INTO leases (arm_id, node_id, lease_owner, expires_at, renewed_at, created_at, updated_at, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    );
    stmt.run(armId, nodeId, armId, expiresAt, now, now, now);

    const record = this.get(armId);
    if (!record) {
      throw new Error(`LeaseService.issue: lease for ${armId} not found after insert`);
    }
    return record;
  }

  /**
   * Renew an existing lease. Updates expires_at = now + extensionMs
   * (default from config.ttlS * 1000), bumps version, emits
   * lease.renewed event.
   */
  async renew(armId: string, extensionMs?: number): Promise<LeaseRecord> {
    const existing = this.get(armId);
    if (!existing) {
      throw new Error(`LeaseService.renew: no lease found for arm ${armId}`);
    }

    const now = Date.now();
    const effectiveExtension = extensionMs ?? this.config.ttlS * 1000;
    const newExpiresAt = now + effectiveExtension;

    const stmt = this.db.prepare(
      "UPDATE leases SET expires_at = ?, renewed_at = ?, updated_at = ?, version = version + 1 " +
        "WHERE arm_id = ?",
    );
    stmt.run(newExpiresAt, now, now, armId);

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "lease",
      entity_id: armId,
      event_type: "lease.renewed",
      actor: existing.lease_owner,
      payload: {
        arm_id: armId,
        node_id: existing.node_id,
        expires_at: newExpiresAt,
      },
    });

    const updated = this.get(armId);
    if (!updated) {
      throw new Error(`LeaseService.renew: lease for ${armId} disappeared after update`);
    }
    return updated;
  }

  /**
   * Expire all leases where expires_at < now. Deletes expired rows and
   * emits lease.expired for each. Returns the list of expired arm_ids
   * and their count.
   */
  async expireStale(now?: number): Promise<{ expired: string[]; count: number }> {
    const threshold = now ?? Date.now();

    const selectStmt = this.db.prepare("SELECT * FROM leases WHERE expires_at < ?");
    const rows = selectStmt.all(threshold) as unknown as LeaseRow[];
    const staleRecords = rows.map(rowToRecord);

    if (staleRecords.length === 0) {
      return { expired: [], count: 0 };
    }

    const deleteStmt = this.db.prepare("DELETE FROM leases WHERE arm_id = ?");
    for (const record of staleRecords) {
      deleteStmt.run(record.arm_id);
    }

    for (const record of staleRecords) {
      await this.eventLog.append({
        schema_version: 1,
        entity_type: "lease",
        entity_id: record.arm_id,
        event_type: "lease.expired",
        actor: "system",
        payload: {
          arm_id: record.arm_id,
          node_id: record.node_id,
          expires_at: record.expires_at,
        },
      });
    }

    return {
      expired: staleRecords.map((r) => r.arm_id),
      count: staleRecords.length,
    };
  }

  /**
   * Get a lease by arm_id. Returns null if no lease exists.
   */
  get(armId: string): LeaseRecord | null {
    const stmt = this.db.prepare("SELECT * FROM leases WHERE arm_id = ?");
    const row = stmt.get(armId) as LeaseRow | undefined;
    if (!row) {
      return null;
    }
    return rowToRecord(row);
  }

  /**
   * Check if a lease is expired. Returns true if no lease exists or if
   * expires_at <= now.
   */
  isExpired(armId: string, now?: number): boolean {
    const record = this.get(armId);
    if (!record) {
      return true;
    }
    const threshold = now ?? Date.now();
    return record.expires_at <= threshold;
  }

  /**
   * Get the grace window in milliseconds based on whether the grip is
   * side-effecting.
   */
  getGraceWindowMs(sideEffecting: boolean): number {
    return sideEffecting ? this.config.sideEffectingGraceS * 1000 : this.config.graceS * 1000;
  }
}
