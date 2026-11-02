import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertRuntimePersistence } from "../../scripts/e2e/lib/upgrade-survivor/dreaming-cron.mjs";

function grantRevision(value: object) {
  const bytes = JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : entry,
  );
  return `sha256:${createHash("sha256").update(bytes).digest("base64url")}`;
}

function fixture() {
  const schedule = { expr: "17 12 20 10 *", kind: "cron", tz: "UTC" };
  const row = (id: string, ordinal: number, timestamp: number, enabled = false) => {
    const grant = {
      id,
      description: "Migrated automation",
      wakeMode: "now",
      schedule: enabled ? schedule : { everyMs: 1_800_000, kind: "every" },
    };
    return {
      store_key: "active",
      job_id: id,
      description: grant.description,
      enabled: Number(enabled),
      job_json: JSON.stringify({ ...grant, enabled, state: {} }),
      state_json: "{}",
      schedule_identity: "{}",
      sort_order: ordinal,
      updated_at: timestamp,
      runtime_updated_at_ms: timestamp,
      grant_definition_updated_at: timestamp,
      grant_definition_generation: 3,
      grant_definition_revision: grantRevision(grant),
    };
  };
  type Row = ReturnType<typeof row>;
  const before: [Row, Row, Row, Row] = [
    row("heartbeat", 0, 1000),
    row("dreaming", 10, 9_000_000_000_000),
    { ...row("authored", 34, 1000), runtime_updated_at_ms: 1010 },
    { ...row("inactive", 19, 1000), store_key: "inactive" },
  ];
  const after = structuredClone(before);
  Object.assign(after[1], {
    ...row("dreaming", after[1].sort_order, Math.max(after[1].runtime_updated_at_ms, 2000), true),
    state_json: JSON.stringify({
      consecutiveErrors: 0,
      scheduleErrorCount: 0,
      nextRunAtMs: 3000,
      scheduleActivatedAtMs: 2000,
    }),
    schedule_identity: JSON.stringify({
      version: 2,
      enabled: true,
      schedule,
      hasTrigger: false,
    }),
    grant_definition_generation: 4,
  });
  return {
    runtime: {
      before: { rows: before },
      storeKey: "active",
      jobId: "dreaming",
      startedAtMs: 1500,
      frequency: schedule.expr,
    },
    rows: after,
  };
}

describe("dreaming runtime persistence assertion", () => {
  it("accepts sparse ordinals, untouched bytes, and only the dreaming-owner mutation", () => {
    const { runtime, rows } = fixture();
    expect(() => assertRuntimePersistence(runtime, rows)).not.toThrow();
  });

  type Rows = ReturnType<typeof fixture>["rows"];
  const change = (index: 0 | 1 | 2 | 3, patch: Partial<Rows[number]>) => (rows: Rows) =>
    Object.assign(rows[index], patch);
  it.each([
    ["migrated automation rewritten by startup", change(0, { enabled: 1 })],
    ["whole-store ordinal compaction", change(2, { sort_order: 2 })],
    ["authored timestamp projection", change(2, { updated_at: 1010 })],
    ["authored JSON reserialization", (rows: Rows) => (rows[2].job_json += " ")],
    ["inactive partition rewrite", change(3, { updated_at: 1001 })],
    ["changed row ordinal rewrite", change(1, { sort_order: 1 })],
    ["regressed future timestamp", change(1, { updated_at: 2000 })],
    ["stale changed definition grant", change(1, { grant_definition_generation: 3 })],
    ["missing row", (rows) => rows.pop()],
    ["duplicate row", (rows) => rows.push(rows[2])],
  ] satisfies [string, (rows: Rows) => unknown][])("rejects %s", (_name, corrupt) => {
    const { runtime, rows } = fixture();
    corrupt(rows);
    expect(() => assertRuntimePersistence(runtime, rows)).toThrow();
  });
});
