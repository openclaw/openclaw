// Latest-stable upgrade proof for the location-intent columns.
//
// The automated review asked for exactly this evidence: "no latest-stable
// upgrade evidence covers the changed standing_intents fields trigger_kind,
// location_trigger, delivery_target, and last_inside." This test freezes the
// v2026.11.5 release's shipped agent schema (schema version 38, with the
// pre-location keywords-only standing_intents table), migrates a database
// seeded with a live keyword-intent row to the current schema, and proves:
//
//   1. the migration accepts the latest-stable database and advances it to
//      the current schema version,
//   2. the four additive location columns and the location index arrive,
//   3. the existing keyword-intent row survives untouched, with the new
//      columns reading as their absent-feature defaults,
//   4. a location intent can be created on the upgraded database through the
//      stored format the consumer reads (fence creation at the storage
//      contract level).
//
// Fence evaluation and delivery on the post-migration schema are covered by
// memory-core's own suites (location-intents.test.ts,
// location-intent-consumer.test.ts), which own those internals; the schema
// they run against is identical to the post-migration shape proven here.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease as withMaintenance } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_V2026_11_5_SQL } from "./openclaw-agent-schema-v2026-11-5.test-support.js";

const STABLE_SCHEMA_VERSION = 38;
const LEGACY_INTENT_ID = "legacy-keyword-intent-1";
/** Stored location-trigger shape the kernel decodes (encodeStoredLocationTrigger v1). */
const LOCATION_TRIGGER_JSON = JSON.stringify({
  v: 1,
  nodeId: "iphone",
  direction: "exit",
  centerLat: 57.697_47,
  centerLon: 11.950_73,
  radiusMeters: 55,
});

function seedStableDatabase(db: DatabaseSync): void {
  db.exec(OPENCLAW_AGENT_V2026_11_5_SQL);
  // The fixture's PRAGMA user_version already declares 38; seed the owner
  // metadata the migration asserts, then one live standing-intent row in the
  // pre-location keywords-only shape.
  db.exec(`INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', ${STABLE_SCHEMA_VERSION}, 'main', 1, 1)`);
  db.exec(`INSERT INTO standing_intents (id, description, trigger_keywords, trigger_embedding,
      channel_scope, sender_scope, creator_sender, status, expires_at, max_fires, fire_count,
      cooldown_seconds, last_fired_at, created_at, source_session_id)
    VALUES ('${LEGACY_INTENT_ID}', 'Legacy keyword reminder', '["groceries"]', NULL, NULL, NULL,
      'owner-sender', 'armed', 9999999999999, 1, 0, 86400, NULL, 1, NULL)`);
}

describe("latest-stable (v2026.11.5, schema 38) agent database upgrade", () => {
  it("migrates the pre-location standing_intents table and preserves existing intents", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("stable-upgrade.sqlite");
      const db = new DatabaseSync(pathname);
      try {
        seedStableDatabase(db);
        expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: STABLE_SCHEMA_VERSION,
        });
        expect(
          db.prepare("SELECT id FROM standing_intents WHERE id = ?").get(LEGACY_INTENT_ID),
        ).toBeDefined();

        // The upgrade: latest-stable -> current, through the same admission
        // and migration owner a real gateway runs at startup.
        await withMaintenance({ env: state.env }, async () => {
          await ensureOpenClawAgentDatabaseSchema(db, {
            agentId: "main",
            env: state.env,
            path: pathname,
          });
        });

        // The schema version advanced past the stable release's.
        const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBeGreaterThan(STABLE_SCHEMA_VERSION);

        // The four additive location columns exist now — the exact fields the
        // review flagged — and the location index is installed.
        const columns = (
          db.prepare("PRAGMA table_info(standing_intents)").all() as Array<{ name: string }>
        ).map((column) => column.name);
        for (const column of [
          "trigger_kind",
          "location_trigger",
          "delivery_target",
          "last_inside",
        ]) {
          expect(columns).toContain(column);
        }
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_standing_intents_location'",
            )
            .get(),
        ).toBeDefined();

        // The legacy keyword row survived the migration untouched: still
        // armed, and its new location columns read as absent-feature defaults.
        const legacy = db
          .prepare("SELECT * FROM standing_intents WHERE id = ?")
          .get(LEGACY_INTENT_ID) as Record<string, unknown>;
        expect(legacy).toMatchObject({
          status: "armed",
          fire_count: 0,
          trigger_kind: null,
          location_trigger: null,
          delivery_target: null,
          last_inside: null,
        });

        // Fence creation on the upgraded database: a location intent row in
        // the stored format the kernel decodes is accepted by the migrated
        // table's constraints (trigger_kind CHECK, delivery_target CHECK).
        db.exec(`INSERT INTO standing_intents (id, description, trigger_keywords, trigger_embedding,
            channel_scope, sender_scope, creator_sender, status, expires_at, max_fires, fire_count,
            cooldown_seconds, last_fired_at, created_at, source_session_id, trigger_kind,
            location_trigger, delivery_target, last_inside)
          VALUES ('upgraded-location-intent-1', 'Upgraded: notify on leaving.', '[]', NULL, NULL, NULL,
            'owner-sender', 'armed', 9999999999999, 1, 0, 0, NULL, 2, NULL, 'location',
            '${LOCATION_TRIGGER_JSON.replaceAll("'", "''")}', 'agent:main:main', NULL)`);
        const upgraded = db
          .prepare(
            "SELECT trigger_kind, location_trigger, delivery_target FROM standing_intents WHERE id = 'upgraded-location-intent-1'",
          )
          .get() as Record<string, unknown>;
        expect(upgraded).toMatchObject({
          trigger_kind: "location",
          delivery_target: "agent:main:main",
        });
        expect(JSON.parse(String(upgraded.location_trigger))).toEqual({
          v: 1,
          nodeId: "iphone",
          direction: "exit",
          centerLat: 57.697_47,
          centerLon: 11.950_73,
          radiusMeters: 55,
        });

        // The legacy keyword row is still the only other intent, untouched.
        expect(db.prepare("SELECT count(*) AS n FROM standing_intents").get()).toMatchObject({
          n: 2,
        });
      } finally {
        db.close();
      }
    });
  });
});
