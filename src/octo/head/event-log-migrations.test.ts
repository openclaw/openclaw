// Octopus Orchestrator — event-log-migrations tests (M1-05)
//
// Covers:
//   - Baseline invariants: CURRENT_EVENT_SCHEMA_VERSION === 1, registry is
//     empty + frozen (OCTO-DEC-018 M1 additive discipline).
//   - migrateToCurrent: no-op pass-through for v1, forward-compat for v2.
//   - migrateEnvelope: happy path (v1 -> v2), chain (v1 -> v2 -> v3),
//     missing-migration error, non-bumping-migration error, over-bumping
//     error, already-at-target no-op, purity (no input mutation).
//   - eventLogReplayDefaults helper shape.
//   - End-to-end acceptance: register a mock v1 -> v2 migration, replay a
//     mixed-version log file through EventLogService.replay, assert every
//     event arrives at v2.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../wire/events.ts";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  EVENT_LOG_MIGRATIONS,
  eventLogReplayDefaults,
  migrateEnvelope,
  migrateToCurrent,
  type MigrationFn,
} from "./event-log-migrations.ts";
import { EventLogService, generateUlid } from "./event-log.ts";

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: generateUlid(),
    schema_version: 1,
    entity_type: "arm",
    entity_id: "arm-test",
    event_type: "arm.created",
    ts: "2025-01-01T00:00:00.000Z",
    actor: "head",
    payload: { foo: "bar" },
    ...overrides,
  };
}

describe("event-log-migrations baseline invariants (M1-05)", () => {
  it("CURRENT_EVENT_SCHEMA_VERSION is 1 (M1 baseline)", () => {
    expect(CURRENT_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("EVENT_LOG_MIGRATIONS is empty (M1 baseline — no breaking changes)", () => {
    expect(Object.keys(EVENT_LOG_MIGRATIONS)).toHaveLength(0);
  });

  it("EVENT_LOG_MIGRATIONS is frozen", () => {
    expect(Object.isFrozen(EVENT_LOG_MIGRATIONS)).toBe(true);
  });
});

describe("migrateToCurrent", () => {
  it("returns a v1 envelope unchanged (already at current)", () => {
    const env = makeEnvelope({ schema_version: 1 });
    const result = migrateToCurrent(env);
    expect(result).toEqual(env);
  });

  it("returns a v2 envelope unchanged (forward compatibility)", () => {
    const env = makeEnvelope({ schema_version: 2 });
    const result = migrateToCurrent(env);
    expect(result).toEqual(env);
    expect(result.schema_version).toBe(2);
  });
});

describe("migrateEnvelope", () => {
  it("applies a registered v1 -> v2 migration to a v1 envelope", () => {
    const m1to2: MigrationFn = (env) => ({
      ...env,
      schema_version: 2,
      payload: { ...env.payload, migrated_field: true },
    });
    const registry: Readonly<Record<number, MigrationFn>> = { 1: m1to2 };
    const env = makeEnvelope({ schema_version: 1 });

    const result = migrateEnvelope(env, 2, registry);
    expect(result.schema_version).toBe(2);
    expect(result.payload.migrated_field).toBe(true);
    expect(result.payload.foo).toBe("bar");
  });

  it("walks a v1 -> v2 -> v3 chain in order", () => {
    const m1to2: MigrationFn = (env) => ({
      ...env,
      schema_version: 2,
      payload: { ...env.payload, step1: true },
    });
    const m2to3: MigrationFn = (env) => ({
      ...env,
      schema_version: 3,
      payload: { ...env.payload, step2: true },
    });
    const registry: Readonly<Record<number, MigrationFn>> = { 1: m1to2, 2: m2to3 };
    const env = makeEnvelope({ schema_version: 1 });

    const result = migrateEnvelope(env, 3, registry);
    expect(result.schema_version).toBe(3);
    expect(result.payload.step1).toBe(true);
    expect(result.payload.step2).toBe(true);
  });

  it("throws when a migration is missing in the chain", () => {
    const m1to2: MigrationFn = (env) => ({ ...env, schema_version: 2 });
    const registry: Readonly<Record<number, MigrationFn>> = { 1: m1to2 };
    const env = makeEnvelope({ schema_version: 1 });

    expect(() => migrateEnvelope(env, 3, registry)).toThrow(
      /no migration registered for schema_version 2 -> 3/,
    );
  });

  it("throws when the first required migration is missing", () => {
    const env = makeEnvelope({ schema_version: 1 });
    expect(() => migrateEnvelope(env, 2, {})).toThrow(
      /no migration registered for schema_version 1 -> 2/,
    );
  });

  it("throws on a non-bumping migration (forgets to increment schema_version)", () => {
    const broken: MigrationFn = (env) => ({ ...env }); // forgets to bump
    const registry: Readonly<Record<number, MigrationFn>> = { 1: broken };
    const env = makeEnvelope({ schema_version: 1 });

    expect(() => migrateEnvelope(env, 2, registry)).toThrow(
      /produced schema_version 1, expected 2/,
    );
  });

  it("throws on an over-bumping migration (skips versions)", () => {
    const broken: MigrationFn = (env) => ({ ...env, schema_version: 3 });
    const registry: Readonly<Record<number, MigrationFn>> = { 1: broken };
    const env = makeEnvelope({ schema_version: 1 });

    expect(() => migrateEnvelope(env, 3, registry)).toThrow(
      /produced schema_version 3, expected 2/,
    );
  });

  it("returns the envelope unchanged when already at target", () => {
    const env = makeEnvelope({ schema_version: 2 });
    const result = migrateEnvelope(env, 2, {});
    expect(result).toBe(env);
  });

  it("returns the envelope unchanged when above target (forward compatibility)", () => {
    const env = makeEnvelope({ schema_version: 5 });
    const result = migrateEnvelope(env, 2, {});
    expect(result).toBe(env);
  });

  it("does not mutate the input envelope (purity)", () => {
    const m1to2: MigrationFn = (env) => ({
      ...env,
      schema_version: 2,
      payload: { ...env.payload, mutated: true },
    });
    const registry: Readonly<Record<number, MigrationFn>> = { 1: m1to2 };
    const env = makeEnvelope({ schema_version: 1, payload: { original: 42 } });
    const snapshot = JSON.parse(JSON.stringify(env)) as EventEnvelope;

    migrateEnvelope(env, 2, registry);
    expect(env).toEqual(snapshot);
    expect(env.schema_version).toBe(1);
    expect(env.payload).toEqual({ original: 42 });
  });
});

describe("eventLogReplayDefaults", () => {
  it("returns the canonical registry and current version", () => {
    const defaults = eventLogReplayDefaults();
    expect(defaults.migrations).toBe(EVENT_LOG_MIGRATIONS);
    expect(defaults.currentSchemaVersion).toBe(CURRENT_EVENT_SCHEMA_VERSION);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// End-to-end acceptance test (M1-05 spec):
//   "register a mock v1→v2 migration, replay a log with mixed versions,
//    verify all events come out at v2"
// ══════════════════════════════════════════════════════════════════════════

describe("event-log-migrations replay acceptance (M1-05)", () => {
  let tmpDir: string;
  let logPath: string;
  let svc: EventLogService;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "octo-event-log-migrations-"));
    logPath = path.join(tmpDir, "octo", "events.jsonl");
    svc = new EventLogService({ path: logPath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replay with a mock v1->v2 migration upgrades every event to v2", async () => {
    mkdirSync(path.dirname(logPath), { recursive: true });

    // Write a mixed-version log directly to bypass append() (which would
    // generate its own schema_version). First event is v1, second is v2,
    // third is v1 again — verifies the walker handles interleaved versions.
    const v1a = {
      event_id: generateUlid(),
      schema_version: 1,
      entity_type: "arm" as const,
      entity_id: "arm-old-a",
      event_type: "arm.created" as const,
      ts: "2025-01-01T00:00:00.000Z",
      actor: "head",
      payload: { legacy: true, slot: "a" },
    };
    const v2a = {
      event_id: generateUlid(),
      schema_version: 2,
      entity_type: "arm" as const,
      entity_id: "arm-new",
      event_type: "arm.created" as const,
      ts: "2025-01-02T00:00:00.000Z",
      actor: "head",
      payload: { upgraded: true, legacy: false },
    };
    const v1b = {
      event_id: generateUlid(),
      schema_version: 1,
      entity_type: "arm" as const,
      entity_id: "arm-old-b",
      event_type: "arm.idle" as const,
      ts: "2025-01-03T00:00:00.000Z",
      actor: "head",
      payload: { legacy: true, slot: "b" },
    };

    writeFileSync(logPath, `${JSON.stringify(v1a)}\n`, "utf8");
    appendFileSync(logPath, `${JSON.stringify(v2a)}\n`, "utf8");
    appendFileSync(logPath, `${JSON.stringify(v1b)}\n`, "utf8");

    // Mock v1 -> v2 migration: adds a `migrated_field: true` marker and
    // bumps schema_version. Pure and total — uses spread to avoid mutation
    // and handles any historical payload shape by treating it as a
    // passthrough dictionary.
    const m1to2: MigrationFn = (env) => ({
      ...env,
      schema_version: 2,
      payload: { ...env.payload, migrated_field: true },
    });

    const collected: EventEnvelope[] = [];
    const count = await svc.replay(
      (e) => {
        collected.push(e);
      },
      {
        migrations: { 1: m1to2 },
        currentSchemaVersion: 2,
      },
    );

    expect(count).toBe(3);
    expect(collected).toHaveLength(3);
    // All three events must be at v2 after replay.
    for (const envelope of collected) {
      expect(envelope.schema_version).toBe(2);
    }
    // v1a and v1b were migrated — they carry the marker.
    expect(collected[0]?.payload.migrated_field).toBe(true);
    expect(collected[0]?.payload.slot).toBe("a");
    expect(collected[2]?.payload.migrated_field).toBe(true);
    expect(collected[2]?.payload.slot).toBe("b");
    // v2a was already at v2 — untouched by the migration.
    expect(collected[1]?.payload.upgraded).toBe(true);
    expect(collected[1]?.payload.migrated_field).toBeUndefined();
  });
});
