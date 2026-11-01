import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSqliteDatabaseWriteTokenForPath as writeToken } from "../infra/sqlite-database-admission.js";
import { useSqliteSchemaTestFixture } from "../infra/sqlite-schema-facts.test-support.js";
import {
  createStateLeaseRenewalScheduler,
  type StateLeaseRenewal as Renewal,
  type StateLeaseRenewalOutcome,
} from "./openclaw-state-lease-renewal.worker.js";

const schema = `CREATE TABLE state_leases (
  scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL,
  expires_at INTEGER, heartbeat_at INTEGER, updated_at INTEGER,
  payload_json TEXT, PRIMARY KEY (scope, lease_key)
)`;

const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();
afterEach(() => vi.useRealTimers());

function fixture(rows: Record<string, number>, filename = ":memory:") {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const db = openDatabase(schema, true, filename);
  const insert = db.prepare(
    "INSERT INTO state_leases VALUES ('test', ?, 'held', ?, 100000, 100000, 'original')",
  );
  for (const [key, expiry] of Object.entries(rows)) {
    insert.run(key, expiry);
  }
  return { db, scheduler: createStateLeaseRenewalScheduler(db) };
}

function renewal(key: string, complete: Renewal["complete"], leaseMs = 300_000): Renewal {
  return {
    identity: { scope: "test", key, owner: "held" },
    leaseMs,
    intervalMs: 30_000,
    execute: (operation) => operation(),
    complete,
  };
}

it("renews owned rows without overwriting payloads or reviving expired owners", async () => {
  const filename = path.join(tempDirs.make("state-lease-renewal-"), "state.sqlite");
  const { db, scheduler } = fixture(
    { first: 400_000, second: 400_000, replaced: 400_000, expired: 400_000 },
    filename,
  );
  const reader = openDatabase("", true, filename);
  const outcomes = new Map<string, StateLeaseRenewalOutcome>();
  for (const key of ["first", "second", "replaced", "expired"]) {
    scheduler.schedule(
      renewal(key, (outcome) => outcomes.set(key, outcome), key === "second" ? 600_000 : 300_000),
      key === "second" ? 700_000 : 400_000,
    );
  }
  db.prepare("UPDATE state_leases SET payload_json = 'updated' WHERE lease_key = 'first'").run();
  db.prepare("UPDATE state_leases SET owner = 'successor' WHERE lease_key = 'replaced'").run();
  db.prepare("UPDATE state_leases SET expires_at = 129999 WHERE lease_key = 'expired'").run();
  const before = writeToken(filename);

  await vi.advanceTimersByTimeAsync(30_000);

  const expected = [
    ["expired", undefined, "held", 129_999, "original"],
    ["first", 430_000, "held", 430_000, "updated"],
    ["replaced", undefined, "successor", 400_000, "original"],
    ["second", 730_000, "held", 730_000, "original"],
  ] as const;
  expect(outcomes).toEqual(new Map(expected.map(([key, expiresAt]) => [key, { expiresAt }])));
  const rows = reader
    .prepare(
      "SELECT lease_key, owner, expires_at, payload_json FROM state_leases ORDER BY lease_key",
    )
    .all();
  expect(rows.map(Object.values)).toEqual(
    expected.map((entry) => entry.filter((_, index) => index !== 1)),
  );
  expect([typeof before, writeToken(filename) !== before]).toEqual(["string", true]);
});

it("joins an existing deadline and keeps the sibling renewing after one lease closes", async () => {
  const { scheduler } = fixture({ first: 400_000, second: 410_000 });
  const renewed = vi.fn();
  const makeEntry = (key: string): Renewal => {
    const entry = renewal(key, (outcome) => {
      if ("expiresAt" in outcome && outcome.expiresAt !== undefined) {
        renewed(key, outcome.expiresAt);
        scheduler.schedule(entry, outcome.expiresAt);
      }
    });
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
