// Octopus Orchestrator — ClaimService (M3-05)
//
// Manages resource claims: acquire, release, expire, conflict detection.
//
// Context docs:
//   - LLD §ClaimService — acquire/release/expire/conflict responsibilities
//   - LLD §ClaimRecord — claim_id, resource_type, resource_key, owner_arm_id,
//     mode (exclusive | shared-read), lease_expiry_ts
//   - DECISIONS.md OCTO-DEC-010 — SQLite for MVP storage
//   - DECISIONS.md OCTO-DEC-033 — boundary discipline (only src/octo/ imports)
//
// Atomicity model (SQLite + node:sqlite sync driver):
//   node:sqlite's DatabaseSync runs all SQL synchronously on the calling
//   thread. In the single-process MVP Head, there is exactly one event loop
//   and all registry calls are synchronous — so a check-then-insert sequence
//   cannot be interleaved by another JS task. We still wrap batch acquires
//   in BEGIN IMMEDIATE / COMMIT for belt-and-suspenders correctness (it
//   prevents interleaving from a hypothetical second connection or future
//   multi-process scenario) and to get all-or-nothing rollback semantics
//   when a conflict is detected mid-batch.

import type { DatabaseSync } from "node:sqlite";
import type { ClaimRequest } from "../wire/schema.ts";
import { generateUlid } from "./event-log.ts";
import type { EventLogService } from "./event-log.ts";
import type { ClaimRecord, RegistryService } from "./registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────

export class ClaimDeniedError extends Error {
  constructor(
    public readonly resource_type: string,
    public readonly resource_key: string,
    public readonly existingOwner: string,
    public readonly requestingArm: string,
  ) {
    super(
      `claim denied: ${resource_type}:${resource_key} is held by ${existingOwner}, ` +
        `requested by ${requestingArm}`,
    );
    this.name = "ClaimDeniedError";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ClaimService
// ──────────────────────────────────────────────────────────────────────────

export class ClaimService {
  constructor(
    private readonly registry: RegistryService,
    private readonly eventLog: EventLogService,
    private readonly db: DatabaseSync,
  ) {}

  /**
   * Acquire claims atomically. ALL succeed or ALL fail (no partial
   * acquisition). For each claim in the batch:
   *
   *   - If an exclusive claim exists by another arm -> deny entire batch
   *   - If requesting exclusive and shared-read claims exist by other arms -> deny
   *   - If requesting shared-read and an exclusive claim exists by another arm -> deny
   *   - If requesting shared-read and only other shared-read claims exist -> allow
   *   - If the requesting arm already owns an equivalent claim -> refresh lease (idempotent)
   *
   * Returns the created/refreshed ClaimRecords on success.
   */
  async acquire(
    armId: string,
    missionId: string,
    gripId: string,
    claims: ClaimRequest[],
    leaseExpiryTs: number,
  ): Promise<ClaimRecord[]> {
    if (claims.length === 0) {
      return [];
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results: ClaimRecord[] = [];

      for (const req of claims) {
        // Query existing claims on (resource_type, resource_key)
        const existing = this.queryResourceClaims(req.resource_type, req.resource_key);

        // Check for conflicts
        const conflict = this.checkConflict(armId, req, existing);
        if (conflict) {
          throw new ClaimDeniedError(
            req.resource_type,
            req.resource_key,
            conflict.owner_arm_id,
            armId,
          );
        }

        // Check if we already own an equivalent claim (idempotent refresh)
        const ownedExisting = existing.find((c) => c.owner_arm_id === armId && c.mode === req.mode);

        if (ownedExisting) {
          // Refresh the lease directly (we're already inside a transaction,
          // so we can't use casUpdateClaim which starts its own transaction).
          const updateStmt = this.db.prepare(
            "UPDATE claims SET lease_expiry_ts = ?, updated_at = ?, version = version + 1 " +
              "WHERE claim_id = ?",
          );
          updateStmt.run(leaseExpiryTs, Date.now(), ownedExisting.claim_id);
          const refreshed = this.registry.getClaim(ownedExisting.claim_id);
          if (!refreshed) {
            throw new Error(`claims: refreshed claim ${ownedExisting.claim_id} disappeared`);
          }
          results.push(refreshed);
        } else {
          // Insert new claim
          const claimId = generateUlid();
          const record = this.registry.putClaim({
            claim_id: claimId,
            mission_id: missionId,
            grip_id: gripId,
            resource_type: req.resource_type,
            resource_key: req.resource_key,
            owner_arm_id: armId,
            mode: req.mode,
            lease_expiry_ts: leaseExpiryTs,
          });
          results.push(record);
        }
      }

      this.db.exec("COMMIT");

      // Emit events outside the transaction (event log is async/file-based)
      for (const record of results) {
        await this.eventLog.append({
          schema_version: 1,
          entity_type: "claim",
          entity_id: record.claim_id,
          event_type: "claim.acquired",
          actor: armId,
          payload: {
            resource_type: record.resource_type,
            resource_key: record.resource_key,
            mode: record.mode,
            owner_arm_id: record.owner_arm_id,
            lease_expiry_ts: record.lease_expiry_ts,
          },
        });
      }

      return results;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /**
   * Release specific claims by ID. Deletes the claim rows and emits
   * claim.released events.
   */
  async release(armId: string, claimIds: string[]): Promise<void> {
    if (claimIds.length === 0) {
      return;
    }

    const released: ClaimRecord[] = [];
    const deleteStmt = this.db.prepare(
      "DELETE FROM claims WHERE claim_id = ? AND owner_arm_id = ?",
    );

    for (const claimId of claimIds) {
      const existing = this.registry.getClaim(claimId);
      if (existing && existing.owner_arm_id === armId) {
        deleteStmt.run(claimId, armId);
        released.push(existing);
      }
    }

    for (const record of released) {
      await this.eventLog.append({
        schema_version: 1,
        entity_type: "claim",
        entity_id: record.claim_id,
        event_type: "claim.released",
        actor: armId,
        payload: {
          resource_type: record.resource_type,
          resource_key: record.resource_key,
          owner_arm_id: record.owner_arm_id,
        },
      });
    }
  }

  /**
   * Expire all claims whose lease_expiry_ts < now. Returns the count of
   * expired claims.
   */
  async expireStale(now?: number): Promise<number> {
    const threshold = now ?? Date.now();
    const expiredClaims = this.queryExpiredClaims(threshold);

    if (expiredClaims.length === 0) {
      return 0;
    }

    const deleteStmt = this.db.prepare("DELETE FROM claims WHERE claim_id = ?");
    for (const claim of expiredClaims) {
      deleteStmt.run(claim.claim_id);
    }

    for (const claim of expiredClaims) {
      await this.eventLog.append({
        schema_version: 1,
        entity_type: "claim",
        entity_id: claim.claim_id,
        event_type: "claim.expired",
        actor: "system",
        payload: {
          resource_type: claim.resource_type,
          resource_key: claim.resource_key,
          owner_arm_id: claim.owner_arm_id,
          lease_expiry_ts: claim.lease_expiry_ts,
        },
      });
    }

    return expiredClaims.length;
  }

  /**
   * Check if a resource is currently claimed exclusively. Returns the
   * exclusive ClaimRecord if one exists, null otherwise.
   */
  isClaimedExclusive(resourceType: string, resourceKey: string): ClaimRecord | null {
    const claims = this.queryResourceClaims(resourceType, resourceKey);
    return claims.find((c) => c.mode === "exclusive") ?? null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Query all claims on a specific (resource_type, resource_key) pair.
   * Uses a direct SQL query against the claims table via the db handle.
   */
  private queryResourceClaims(resourceType: string, resourceKey: string): ClaimRecord[] {
    const stmt = this.db.prepare(
      "SELECT * FROM claims WHERE resource_type = ? AND resource_key = ?",
    );
    const rows = stmt.all(resourceType, resourceKey) as unknown as Array<{
      claim_id: string;
      mission_id: string | null;
      grip_id: string | null;
      resource_type: string;
      resource_key: string;
      owner_arm_id: string;
      mode: string;
      lease_expiry_ts: number | bigint;
      created_at: number | bigint;
      updated_at: number | bigint;
      version: number | bigint;
    }>;
    return rows.map((row) => ({
      claim_id: row.claim_id,
      mission_id: row.mission_id,
      grip_id: row.grip_id,
      resource_type: row.resource_type,
      resource_key: row.resource_key,
      owner_arm_id: row.owner_arm_id,
      mode: row.mode as "exclusive" | "shared-read",
      lease_expiry_ts: Number(row.lease_expiry_ts),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      version: Number(row.version),
    }));
  }

  /**
   * Query all claims whose lease has expired (lease_expiry_ts < threshold).
   */
  private queryExpiredClaims(threshold: number): ClaimRecord[] {
    const stmt = this.db.prepare("SELECT * FROM claims WHERE lease_expiry_ts < ?");
    const rows = stmt.all(threshold) as unknown as Array<{
      claim_id: string;
      mission_id: string | null;
      grip_id: string | null;
      resource_type: string;
      resource_key: string;
      owner_arm_id: string;
      mode: string;
      lease_expiry_ts: number | bigint;
      created_at: number | bigint;
      updated_at: number | bigint;
      version: number | bigint;
    }>;
    return rows.map((row) => ({
      claim_id: row.claim_id,
      mission_id: row.mission_id,
      grip_id: row.grip_id,
      resource_type: row.resource_type,
      resource_key: row.resource_key,
      owner_arm_id: row.owner_arm_id,
      mode: row.mode as "exclusive" | "shared-read",
      lease_expiry_ts: Number(row.lease_expiry_ts),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      version: Number(row.version),
    }));
  }

  /**
   * Check if a claim request conflicts with existing claims. Returns the
   * conflicting ClaimRecord if a conflict exists, undefined otherwise.
   */
  private checkConflict(
    armId: string,
    request: ClaimRequest,
    existing: ClaimRecord[],
  ): ClaimRecord | undefined {
    for (const claim of existing) {
      // Own claims never conflict
      if (claim.owner_arm_id === armId) {
        continue;
      }

      if (request.mode === "exclusive") {
        // Exclusive request conflicts with any existing claim by another arm
        return claim;
      }

      // shared-read request
      if (claim.mode === "exclusive") {
        // shared-read conflicts with existing exclusive by another arm
        return claim;
      }
      // shared-read + shared-read by another arm -> no conflict
    }
    return undefined;
  }
}
