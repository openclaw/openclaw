import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import { executeOpenClawStateLeaseCommand } from "./openclaw-state-lease-worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["renewed", "replaced", "expired", "refused"] as const)(
  "verifies lease state after host admission without pinning the WAL (%s)",
  (change) => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const databasePath = path.join(tempDirs.make("lease-verify-"), "state.sqlite");
    const db = new DatabaseSync(databasePath);
    const peer = new DatabaseSync(databasePath);
    const identity = { scope: "synthetic", key: "verify", owner: "original" };
    const observation = new BigInt64Array(new SharedArrayBuffer(48));
    const database: OpenClawStateDatabase = {
      db,
      path: databasePath,
      walMaintenance: {
        checkpoint: vi.fn(() => false),
        close: vi.fn(() => false),
        reclaimFreePages: vi.fn(() => {
          throw new Error("Verification must not run maintenance");
        }),
      },
    };
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE state_leases(scope TEXT, lease_key TEXT, owner TEXT, expires_at INTEGER);
      INSERT INTO state_leases VALUES ('synthetic', 'verify', 'original', 20000);
    `);
    peer.exec("PRAGMA busy_timeout=0");
    let checkpoint: unknown;
    const admission = createSqliteWorkerOperationAdmission(
      (request, grant) => {
        expect(request).toEqual({
          stage: "transaction",
          facts: { kind: "state-lease-verify", identity, expiresAt: 20_000 },
        });
        if (change === "refused") {
          throw new Error("Live owner retired");
        }
        if (change === "replaced") {
          peer.exec("UPDATE state_leases SET owner='replacement'");
        } else {
          peer.exec("UPDATE state_leases SET expires_at=30000");
        }
        if (change === "expired") {
          now = 30_000;
        }
        checkpoint = peer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        grant();
      },
      { kind: "state-lease-expiry", identity, observation: observation.buffer },
    );
    // Service the real private-port grant at the native wait, without sleeping.
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    const verify = () =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
        executeOpenClawStateLeaseCommand(
          { type: "stateLease.verify", input: { identity } },
          database,
        ),
      );
    try {
      if (change === "renewed") {
        expect(verify()).toBe(30_000);
        expect(Atomics.load(observation, leaseHeartbeatState.expiresAt)).toBe(30_000n);
      } else {
        expect(verify).toThrow(
          expect.objectContaining({
            code: change === "refused" ? "closed" : "OPENCLAW_STATE_LEASE_LOST",
          }),
        );
        expect(Atomics.load(observation, leaseHeartbeatState.expiresAt)).toBe(0n);
      }
      if (change !== "refused") {
        expect(checkpoint).toMatchObject({ busy: 0, log: 0, checkpointed: 0 });
      } else {
        expect(admission.failure).toMatchObject({ message: "Live owner retired" });
      }
      expect(db.isTransaction).toBe(false);
    } finally {
      admission.finish();
      peer.close();
      db.close();
    }
  },
);
