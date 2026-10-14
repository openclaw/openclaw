import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeNodeSqliteDependents } from "../infra/kysely-sync-cache-state.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "./openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";

vi.mock("../infra/sqlite-worker-operation-admission.js", () => ({
  requestSqliteWorkerOperationAdmission: vi.fn(),
}));

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    disposeNodeSqliteDependents(db);
    db.close();
  }
  vi.mocked(requestSqliteWorkerOperationAdmission).mockReset();
  vi.restoreAllMocks();
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    "CREATE TABLE state_leases (scope TEXT, lease_key TEXT, owner TEXT, expires_at INTEGER); CREATE TABLE writes (value TEXT)",
  );
  const identities: [OpenClawStateLeaseIdentity, OpenClawStateLeaseIdentity] = [
    { scope: "skill-collection", key: "main", owner: "collection-owner" },
    { scope: "skill-workshop-target", key: "main:target", owner: "target-owner" },
  ];
  const expiresAt = Date.now() + 30_000;
  const insert = db.prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?)");
  for (const identity of identities) {
    insert.run(identity.scope, identity.key, identity.owner, expiresAt);
  }
  return { db, identities, expiresAt };
}

describe("worker transaction lease group", () => {
  it.each(["replacement", "expiry"] as const)(
    "rechecks every owner after a host grant (%s)",
    (change) => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const { db, identities, expiresAt } = fixture();
      db.exec("BEGIN IMMEDIATE");
      if (change === "replacement") {
        assertOpenClawStateLeasesWorkerOwnedInTransaction(db, identities);
        expect(requestSqliteWorkerOperationAdmission).toHaveBeenCalledExactlyOnceWith({
          stage: "transaction",
          facts: {
            kind: "state-leases",
            leases: identities.map((identity) => ({ identity, expiresAt })),
          },
        });
        db.prepare("INSERT INTO writes VALUES (?)").run("prepared");
      }
      vi.mocked(requestSqliteWorkerOperationAdmission).mockImplementationOnce(() => {
        if (change === "replacement") {
          db.prepare("UPDATE state_leases SET owner = ? WHERE lease_key = ?").run(
            "replacement",
            identities[1].key,
          );
        } else {
          now = expiresAt;
        }
      });
      expect(() =>
        assertOpenClawStateLeasesWorkerOwnedInTransaction(
          db,
          identities,
          change === "replacement" ? "commit" : "transaction",
        ),
      ).toThrow("was lost");
      if (change === "replacement") {
        db.exec("ROLLBACK");
        expect(db.prepare("SELECT count(*) AS count FROM writes").get()?.count).toBe(0);
      } else {
        expect(requestSqliteWorkerOperationAdmission).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["expired-first", "expired-second", "invalid-set"] as const)(
    "refuses %s before requesting authority",
    (kind) => {
      const { db, identities } = fixture();
      if (kind === "invalid-set") {
        expect(() => assertOpenClawStateLeasesWorkerOwnedInTransaction(db, identities)).toThrow(
          "active transaction",
        );
      } else {
        db.prepare("UPDATE state_leases SET expires_at = ? WHERE lease_key = ?").run(
          Date.now(),
          identities[kind === "expired-first" ? 0 : 1].key,
        );
      }
      db.exec("BEGIN IMMEDIATE");
      const selections =
        kind === "invalid-set" ? [[], [identities[0], identities[0]]] : [identities];
      for (const selected of selections) {
        expect(() => assertOpenClawStateLeasesWorkerOwnedInTransaction(db, selected)).toThrow(
          kind === "invalid-set" ? "distinct live leases" : "was lost",
        );
      }
      expect(requestSqliteWorkerOperationAdmission).not.toHaveBeenCalled();
    },
  );
});
