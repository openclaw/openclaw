import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSqliteDatabaseWriteTokenForPath } from "../infra/sqlite-database-admission.js";
import { useSqliteSchemaTestFixture } from "../infra/sqlite-schema-facts.test-support.js";
import {
  createStateLeaseRenewalScheduler,
  type StateLeaseRenewal,
  type StateLeaseRenewalOutcome,
} from "./openclaw-state-lease-renewal.worker.js";

const schema = `CREATE TABLE state_leases (
  scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL,
  expires_at INTEGER, heartbeat_at INTEGER, updated_at INTEGER,
  payload_json TEXT, PRIMARY KEY (scope, lease_key)
)`;

describe("shared state lease renewal", () => {
  const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();
  afterEach(() => vi.useRealTimers());

  it("renews owned rows together without overwriting payloads or reviving expired owners", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const filename = path.join(tempDirs.make("state-lease-renewal-"), "state.sqlite");
    const db = openDatabase(schema, true, filename);
    const reader = openDatabase("", true, filename);
    const insert = db.prepare(
      "INSERT INTO state_leases VALUES ('test', ?, 'held', ?, 100000, 100000, 'original')",
    );
    for (const key of ["first", "second", "replaced", "expired"]) {
      insert.run(key, 400_000);
    }
    const scheduler = createStateLeaseRenewalScheduler(db);
    const outcomes = new Map<string, StateLeaseRenewalOutcome>();
    for (const key of ["first", "second", "replaced", "expired"]) {
      scheduler.schedule(
        {
          identity: { scope: "test", key, owner: "held" },
          leaseMs: key === "second" ? 600_000 : 300_000,
          intervalMs: 30_000,
          execute: (operation) => operation(),
          complete: (outcome) => outcomes.set(key, outcome),
        },
        key === "second" ? 700_000 : 400_000,
      );
    }
    db.prepare("UPDATE state_leases SET payload_json = 'updated' WHERE lease_key = 'first'").run();
    db.prepare("UPDATE state_leases SET owner = 'successor' WHERE lease_key = 'replaced'").run();
    db.prepare("UPDATE state_leases SET expires_at = 129999 WHERE lease_key = 'expired'").run();
    const before = readSqliteDatabaseWriteTokenForPath(filename);
    expect(before).toBeTypeOf("string");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(outcomes).toEqual(
      new Map([
        ["first", { expiresAt: 430_000 }],
        ["second", { expiresAt: 730_000 }],
        ["replaced", { expiresAt: undefined }],
        ["expired", { expiresAt: undefined }],
      ]),
    );
    expect(
      reader
        .prepare(
          "SELECT lease_key, owner, expires_at, payload_json FROM state_leases ORDER BY lease_key",
        )
        .all(),
    ).toEqual([
      { lease_key: "expired", owner: "held", expires_at: 129_999, payload_json: "original" },
      { lease_key: "first", owner: "held", expires_at: 430_000, payload_json: "updated" },
      { lease_key: "replaced", owner: "successor", expires_at: 400_000, payload_json: "original" },
      { lease_key: "second", owner: "held", expires_at: 730_000, payload_json: "original" },
    ]);
    expect(readSqliteDatabaseWriteTokenForPath(filename)).not.toBe(before);
  });

  it("joins an existing deadline and keeps the sibling renewing after one lease closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const db = openDatabase(schema);
    db.prepare(
      "INSERT INTO state_leases VALUES ('test', 'first', 'held', 400000, 0, 0, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO state_leases VALUES ('test', 'second', 'held', 410000, 0, 0, NULL)",
    ).run();
    const scheduler = createStateLeaseRenewalScheduler(db);
    const renewed = vi.fn();
    const makeEntry = (key: string): StateLeaseRenewal => {
      const entry: StateLeaseRenewal = {
        identity: { scope: "test", key, owner: "held" },
        leaseMs: 300_000,
        intervalMs: 30_000,
        execute: (operation) => operation(),
        complete(outcome) {
          if ("expiresAt" in outcome && outcome.expiresAt !== undefined) {
            renewed(key, outcome.expiresAt);
            scheduler.schedule(entry, outcome.expiresAt);
          }
        },
      };
      return entry;
    };
    const first = makeEntry("first");
    const second = makeEntry("second");
    scheduler.schedule(first, 400_000);
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.schedule(second, 410_000);
    scheduler.cancel(first);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renewed.mock.calls).toEqual([["second", 430_000]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewed.mock.calls).toEqual([
      ["second", 430_000],
      ["second", 460_000],
    ]);
    scheduler.cancel(second);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewed).toHaveBeenCalledTimes(2);
  });
});
