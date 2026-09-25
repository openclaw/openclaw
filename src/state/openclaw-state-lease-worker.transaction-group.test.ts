import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeNodeSqliteDependents } from "../infra/kysely-sync-cache-state.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "./openclaw-state-lease-worker.js";

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
  it("requests one complete grant per boundary and reads every owner again after the grant", () => {
    const { db, identities, expiresAt } = fixture();
    db.exec("BEGIN IMMEDIATE");
    assertOpenClawStateLeasesWorkerOwnedInTransaction(db, identities);
    expect(requestSqliteWorkerOperationAdmission).toHaveBeenCalledExactlyOnceWith({
      stage: "transaction",
      facts: {
        kind: "state-leases",
        leases: identities.map((identity) => ({ identity, expiresAt })),
      },
    });
    db.prepare("INSERT INTO writes VALUES (?)").run("prepared");
    vi.mocked(requestSqliteWorkerOperationAdmission).mockImplementationOnce(() => {
      db.prepare("UPDATE state_leases SET owner = ? WHERE lease_key = ?").run(
        "replacement",
        identities[1].key,
      );
    });
    expect(() =>
      assertOpenClawStateLeasesWorkerOwnedInTransaction(db, identities, "commit"),
    ).toThrow("was lost");
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT count(*) AS count FROM writes").get()?.count).toBe(0);
  });

  it.each([0, 1] as const)("refuses an expired member %s before requesting authority", (index) => {
    const { db, identities } = fixture();
    db.prepare("UPDATE state_leases SET expires_at = ? WHERE lease_key = ?").run(
      Date.now(),
      identities[index].key,
    );
    db.exec("BEGIN IMMEDIATE");
    expect(() => assertOpenClawStateLeasesWorkerOwnedInTransaction(db, identities)).toThrow(
      "was lost",
    );
    expect(requestSqliteWorkerOperationAdmission).not.toHaveBeenCalled();
  });

  it("checks expiry again after a delayed host grant", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { db, identities, expiresAt } = fixture();
    db.exec("BEGIN IMMEDIATE");
    vi.mocked(requestSqliteWorkerOperationAdmission).mockImplementationOnce(() => {
      now = expiresAt;
    });
    expect(() => assertOpenClawStateLeasesWorkerOwnedInTransaction(db, identities)).toThrow(
      "was lost",
    );
    expect(requestSqliteWorkerOperationAdmission).toHaveBeenCalledOnce();
  });

  it("requires a transaction and a nonempty distinct lease set", () => {
    const { db, identities } = fixture();
    expect(() => assertOpenClawStateLeasesWorkerOwnedInTransaction(db, identities)).toThrow(
      "active transaction",
    );
    db.exec("BEGIN IMMEDIATE");
    for (const selected of [[], [identities[0], identities[0]]]) {
      expect(() => assertOpenClawStateLeasesWorkerOwnedInTransaction(db, selected)).toThrow(
        "distinct live leases",
      );
    }
    expect(requestSqliteWorkerOperationAdmission).not.toHaveBeenCalled();
  });
});
