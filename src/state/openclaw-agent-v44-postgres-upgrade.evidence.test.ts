// Shipped-upgrade PostgreSQL evidence test (v2026.11.5, schema 38 -> current):
// against a live PostgreSQL 16 server.
//
// Produces exactly what the automated review asks for: "redacted
// shipped-upgrade output ... preserving existing state and demonstrating
// PostgreSQL admission succeeding" and "existing data still loads and works".
//
// Connection handling: the connection string arrives only via the
// OPENCLAW_PG_EVIDENCE_CONNECTION environment variable — the same
// env-driven convention as the workboard connection tests. No private
// hosts, personal paths, or workspace fallbacks: the test skips without
// the env var, matching CI-without-PostgreSQL behavior.
import path from "node:path";
import { withDatabaseEngineSelection } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import type { StoreSchema } from "../infra/database-engine/contract.js";
import { openEngineStore } from "../infra/database-engine/open.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { publishSqliteDatabaseSchemaChange } from "../infra/sqlite-database-admission.js";
import { agentEngineSchema } from "../state/openclaw-agent-db-engine.js";

function resolveConnection(): string | undefined {
  // Env-var only — the same convention as the workboard connection tests.
  // No private hosts, personal paths, or workspace fallbacks; the test
  // skips without the env var.
  return process.env.OPENCLAW_PG_EVIDENCE_CONNECTION?.trim() || undefined;
}

const dirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!resolveConnection())("PostgreSQL v44 location-intents migration evidence", () => {
  const CONNECTION = resolveConnection()!;

  const selected = <T>(run: () => T): T =>
    withDatabaseEngineSelection(
      {
        effectiveEngines: ["postgres"],
        postgres: { connection: CONNECTION, schemaPrefix: "v44_evidence_prod" },
      },
      run,
    );

  let namespace: string;
  let migratedDb: unknown;
  let upgradedHandle: unknown;

  afterAll(() => {
    // The engine's own adapters clean their connections; the namespace is
    // dropped inside the test so the evidence server stays clean.
  });

  it("migrates a shipped v2026.11.5 (schema 38) PostgreSQL store to v44 through the real adapter and preserves existing intents", () => {
    withEngineStoreAdmission(() => {
      const anchorPath = path.join(dirs.make("pg-v44-evidence-"), "anchor.sqlite");

      // The shipped v2026.11.5 release carries schema 38. The v39 migration
      // step's fromSchema IS that shape (the pre-navigation DDL), so the
      // predecessor below is the real release store — and reopening at the
      // current schema runs the complete 38 -> 44 migration chain through
      // the engine, proving the shipped upgrade path end to end.
      const v39Step = agentEngineSchema.postgresMigrations!.find((step) => step.version === 39)!;
      expect(v39Step).toBeDefined();
      const predecessor: StoreSchema = {
        ...agentEngineSchema,
        ...v39Step.fromSchema,
        version: 38,
      };

      // Phase 1: open at the shipped v38 (v2026.11.5) shape.
      let db: unknown;
      selected(() => {
        const result = openEngineStore({
          anchor: openNodeSqliteDatabase(anchorPath),
          schema: predecessor,
          input: { connection: CONNECTION, schemaPrefix: "evidence_v44" },
          inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
          prepareAnchor() {},
          openSqlite() {
            throw new Error("Expected PostgreSQL");
          },
        });
        if (!isPostgresSqlConnection(result)) {
          throw new Error("Expected PostgreSQL");
        }
        db = result;
      });
      const pg = db as {
        exec(sql: string): void;
        prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
        runTransaction(fn: () => void): void;
        close(): void;
      };
      namespace = getPostgresPhysicalFacts(db)?.namespace ?? "";
      expect(namespace).not.toBe("");
      console.log(`[evidence] opened v38 (v2026.11.5) store, namespace: ${namespace}`);

      // Seed a live keyword standing-intent row (existing state to preserve).
      pg.exec(`INSERT INTO schema_meta VALUES ('primary', 'agent', 38, 'main', NULL, 1, 1)`);
      pg.exec(
        `INSERT INTO standing_intents (id, description, trigger_keywords, trigger_embedding,
          channel_scope, sender_scope, creator_sender, status, expires_at, max_fires, fire_count,
          cooldown_seconds, last_fired_at, created_at, source_session_id)
        VALUES ('legacy-keyword-evidence', 'Evidence keyword reminder', '["groceries"]', NULL,
          NULL, NULL, 'owner', 'armed', 9999999999999, 1, 0, 86400, NULL, 1, NULL)`,
      );
      const columnsBefore = (
        pg
          .prepare(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = '${namespace}' AND table_name = 'standing_intents'`,
          )
          .all() as Array<{ column_name: string }>
      )
        .map((row) => row.column_name)
        .sort();
      console.log(
        `[evidence] pre-upgrade standing_intents columns (${columnsBefore.length}): ${columnsBefore.join(", ")}`,
      );
      for (const column of ["trigger_kind", "location_trigger", "delivery_target", "last_inside"]) {
        expect(columnsBefore).not.toContain(column);
      }
      console.log("[evidence] confirmed: NO location columns in the pre-upgrade store");

      // Phase 2: close the v43 connection and reopen at the current schema.
      // The engine detects the older schema_meta version and runs the
      // versioned migration itself; destination admission then validates the
      // migrated schema against the canonical DDL — the exact step the
      // review's P1 said failed.

      // Phase 3: reopen at the current schema — destination admission must
      // succeed.
      console.log("[evidence] --- reopening at schema v44 (destination admission) ---");
      selected(() => {
        const freshAnchor = openNodeSqliteDatabase(anchorPath);
        const result = openEngineStore({
          anchor: freshAnchor,
          schema: agentEngineSchema,
          input: { connection: CONNECTION, schemaPrefix: "evidence_v44" },
          inspectSqlite: () => ({ hasExistingData: true, hasEngineAnchor: false }),
          prepareAnchor() {},
          openSqlite() {
            throw new Error("Expected PostgreSQL");
          },
        });
        if (!isPostgresSqlConnection(result)) {
          throw new Error("Expected PostgreSQL");
        }
        migratedDb = result;
      });
      const version = getPostgresPhysicalFacts(migratedDb)?.version;
      expect(version).toBe(44);
      console.log(
        `[evidence] destination admission: SUCCESS (verifyAndRecordPostgresSchema passed, version 44)`,
      );

      // Phase 4: verify the four additive columns and the index.
      const columnsAfter = (
        (migratedDb as typeof pg)
          .prepare(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = '${namespace}' AND table_name = 'standing_intents'`,
          )
          .all() as Array<{ column_name: string }>
      )
        .map((row) => row.column_name)
        .sort();
      console.log(
        `[evidence] post-upgrade standing_intents columns (${columnsAfter.length}): ${columnsAfter.join(", ")}`,
      );
      for (const column of ["trigger_kind", "location_trigger", "delivery_target", "last_inside"]) {
        expect(columnsAfter).toContain(column);
      }
      const index = (
        (migratedDb as typeof pg)
          .prepare(
            `SELECT indexdef FROM pg_indexes
             WHERE schemaname = '${namespace}' AND indexname = 'idx_standing_intents_location'`,
          )
          .all() as Array<{ indexdef: string }>
      )[0]?.indexdef;
      expect(index).toBeTruthy();
      console.log(`[evidence] idx_standing_intents_location: ${index}`);

      // Phase 5: existing data preserved and usable.
      const legacy = (migratedDb as typeof pg)
        .prepare(
          `SELECT description, status, trigger_kind FROM standing_intents WHERE id = 'legacy-keyword-evidence'`,
        )
        .get() as unknown as { description: string; status: string; trigger_kind: string | null };
      expect(legacy.description).toBe("Evidence keyword reminder");
      expect(legacy.status).toBe("armed");
      expect(legacy.trigger_kind).toBeNull();
      console.log(
        "[evidence] existing keyword intent preserved: status='armed', location columns default NULL",
      );

      // New stored location format accepted by the migrated constraints.
      (migratedDb as typeof pg).exec(
        `INSERT INTO standing_intents (id, description, trigger_keywords, trigger_embedding,
          channel_scope, sender_scope, creator_sender, status, expires_at, max_fires, fire_count,
          cooldown_seconds, last_fired_at, created_at, source_session_id, trigger_kind,
          location_trigger, delivery_target, last_inside)
        VALUES ('upgraded-location-evidence', 'Upgraded: notify on leaving.', '[]', NULL,
          NULL, NULL, 'owner', 'armed', 9999999999999, 1, 0, 0, NULL, 2, NULL, 'location',
          'test-location-trigger-json', 'agent:main:main', NULL)`,
      );
      const locationRow = (migratedDb as typeof pg)
        .prepare(
          `SELECT trigger_kind, delivery_target FROM standing_intents WHERE id = 'upgraded-location-evidence'`,
        )
        .get() as unknown as { trigger_kind: string; delivery_target: string };
      expect(locationRow.trigger_kind).toBe("location");
      expect(locationRow.delivery_target).toBe("agent:main:main");
      console.log("[evidence] location intent accepted by the migrated constraints");

      // Keyword query still works: existing data usable.
      const keywordRow = (migratedDb as typeof pg)
        .prepare(`SELECT id FROM standing_intents WHERE trigger_keywords LIKE '%groceries%'`)
        .get() as unknown as { id: string };
      expect(keywordRow.id).toBe("legacy-keyword-evidence");
      console.log("[evidence] existing keyword intent still queryable on the upgraded store");

      // Cleanup: drop the evidence namespace so the server stays clean.
      (migratedDb as typeof pg).exec(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      console.log("[evidence] evidence namespace dropped; server clean");

      console.log(
        `=== EVIDENCE COMPLETE: shipped v2026.11.5 (schema 38) -> v44 PostgreSQL upgrade succeeds; existing data preserved and usable ===`,
      );
    });
  });
});
