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
  const heartbeat = {
    id: "heartbeat",
    enabled: true,
    description: "Heartbeat",
    schedule: { everyMs: 1_800_000, kind: "every" },
    state: {},
    wakeMode: "next-heartbeat",
  };
  const dreaming = { ...heartbeat, id: "dreaming", enabled: false };
  const row = (definition: typeof heartbeat, ordinal: number, timestamp: number) => {
    const { enabled: _enabled, state: _state, ...grant } = definition;
    return {
      store_key: "active",
      job_id: definition.id,
      description: definition.description,
      enabled: definition.enabled ? 1 : 0,
      job_json: JSON.stringify(definition),
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
    row(heartbeat, 0, 1000),
    row(dreaming, 10, 9_000_000_000_000),
    { ...row({ ...heartbeat, id: "authored" }, 34, 1000), runtime_updated_at_ms: 1010 },
    { ...row({ ...heartbeat, id: "inactive" }, 19, 1000), store_key: "inactive" },
  ];
  const after = structuredClone(before);
  for (const entry of after.slice(0, 2)) {
    const isDreaming = entry.job_id === "dreaming";
    const definition = isDreaming
      ? {
          ...dreaming,
          enabled: true,
          schedule: { expr: "17 12 20 10 *", kind: "cron", tz: "UTC" },
          wakeMode: "now",
        }
      : { ...heartbeat, enabled: false };
    const { enabled: _enabled, state: _state, ...grant } = definition;
    const timestamp = Math.max(entry.runtime_updated_at_ms, 2000);
    Object.assign(entry, {
      enabled: definition.enabled ? 1 : 0,
      job_json: JSON.stringify(definition),
      state_json: JSON.stringify({
        ...(isDreaming ? { consecutiveErrors: 0, scheduleErrorCount: 0, nextRunAtMs: 3000 } : {}),
        scheduleActivatedAtMs: 2000,
      }),
      schedule_identity: JSON.stringify({
        version: 2,
        enabled: definition.enabled,
        schedule: definition.schedule,
        hasTrigger: false,
      }),
      updated_at: timestamp,
      runtime_updated_at_ms: timestamp,
      grant_definition_updated_at: timestamp,
      grant_definition_generation: isDreaming ? 4 : 3,
      grant_definition_revision: grantRevision(grant),
    });
  }
  return {
    runtime: {
      before: { rows: before },
      storeKey: "active",
      jobId: "dreaming",
      startedAtMs: 1500,
      frequency: "17 12 20 10 *",
    },
    rows: after,
  };
}

describe("dreaming runtime persistence assertion", () => {
  it("accepts sparse ordinals, untouched bytes, and only the two config-owner mutations", () => {
    const { runtime, rows } = fixture();
    expect(() => assertRuntimePersistence(runtime, rows, "heartbeat")).not.toThrow();
  });

  it.each<[string, (rows: ReturnType<typeof fixture>["rows"]) => unknown]>([
    ["whole-store ordinal compaction", (rows) => Object.assign(rows[2], { sort_order: 2 })],
    ["authored timestamp projection", (rows) => Object.assign(rows[2], { updated_at: 1010 })],
    [
      "authored JSON reserialization",
      (rows) => Object.assign(rows[2], { job_json: rows[2].job_json + " " }),
    ],
    [
      "inactive partition rewrite",
      (rows) => Object.assign(rows[3], { updated_at: rows[3].updated_at + 1 }),
    ],
    ["changed row ordinal rewrite", (rows) => Object.assign(rows[1], { sort_order: 1 })],
    ["regressed future timestamp", (rows) => Object.assign(rows[1], { updated_at: 2000 })],
    [
      "stale changed definition grant",
      (rows) => Object.assign(rows[1], { grant_definition_generation: 3 }),
    ],
    ["missing row", (rows) => rows.pop()],
    ["duplicate row", (rows) => rows.push(rows[2])],
  ])("rejects %s", (_name, corrupt) => {
    const { runtime, rows } = fixture();
    corrupt(rows);
    expect(() => assertRuntimePersistence(runtime, rows, "heartbeat")).toThrow();
  });
});
