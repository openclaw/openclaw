import { channel } from "node:diagnostics_channel";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { agentEngineSchema } from "../../state/openclaw-agent-db-engine.js";
import { stateEngineSchema } from "../../state/openclaw-state-db-engine.js";
import type { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { createPostgresEngineTestFixture } from "./engine-store.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

function indexes(db: PostgresSyncConnection) {
  return db
    .prepare(
      `SELECT c.relname AS name, c.oid::text AS oid, i.indisprimary AS primary_key,
        pg_get_indexdef(c.oid) AS definition, i.indoption::text AS options
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE n.nspname = ? ORDER BY c.relname`,
    )
    .all(db.schema);
}

describe.skipIf(!connection)("PostgreSQL index ordering migration", () => {
  it.each(["state", "agent"] as const)(
    "upgrades populated %s stores selectively and admits the result without more DDL",
    (kind) => {
      withEngineStoreAdmission(() => {
        const currentSchema = kind === "state" ? stateEngineSchema : agentEngineSchema;
        // Pin the non-null index ordering step; later steps (agent 35 and newer)
        // keep their predecessor's search and vector versions out of this fixture.
        const migration = currentSchema.postgresMigrations?.find(
          (step) => step.version === (kind === "state" ? 32 : 34),
        );
        if (!migration) {
          throw new Error(`Missing non-null index ordering ${kind} PostgreSQL migration`);
        }
        const target: StoreSchema = {
          ...currentSchema,
          ...migration.schema,
          version: migration.version,
          postgresVectorDecoderVersion: migration.schema.postgresVectorDecoderVersion,
          postgresVectorSearchVersion: migration.schema.postgresVectorSearchVersion,
          postgresTextSearchVersion: migration.schema.postgresTextSearchVersion,
          postgresMigrations: currentSchema.postgresMigrations?.filter(
            (step) => step.version <= migration.version,
          ),
        };
        const source: StoreSchema = {
          ...target,
          ...migration.fromSchema,
          version: migration.version - 1,
          postgresVectorDecoderVersion: migration.fromSchema.postgresVectorDecoderVersion,
          postgresVectorSearchVersion: migration.fromSchema.postgresVectorSearchVersion,
          postgresTextSearchVersion: migration.fromSchema.postgresTextSearchVersion,
          postgresMigrations: [],
          postgresFragments: migration.fromSchema.postgresFragments?.map((fragment) =>
            fragment.id === "update_runs"
              ? Object.assign({}, fragment, { activation: "version-additive" as const })
              : fragment,
          ),
        };
        using fixture = createPostgresEngineTestFixture({
          directory: dirs.make(`pg-index-order-${kind}-`),
          connection: connection!,
          schemaPrefix: "index_order_test",
          schema: source,
        });
        const { open, invalidate } = fixture;
        const original = open(source);
        original.runTransaction(() => {
          original
            .prepare(`INSERT INTO schema_meta
              (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
              VALUES ('primary', ?, ?, ?, 'migration-fixture', 0, 0)`)
            .run(
              kind === "state" ? "global" : "agent",
              source.version,
              kind === "state" ? null : "fixture",
            );
          if (kind === "state") {
            original.exec(`INSERT INTO meeting_transcript_sessions
                (session_id, started_at, started_at_ms, selector, export_key, session_slug,
                  provider_id, source_json, created_at_ms, updated_at_ms)
                SELECT 'session-' || n, 'time-' || n, CASE WHEN n = 1 THEN NULL ELSE n * 10 END,
                  'selector-' || n, 'export-' || n, 'slug-' || n, 'fixture', '{}', 0, 0
                FROM generate_series(1, 3) AS n`);
          } else {
            original.exec(`INSERT INTO memory_embedding_cache
                (provider, model, provider_key, hash, embedding, dims, updated_at)
                SELECT 'fixture', 'fixture', 'fixture', 'hash-' || n, decode('0102', 'hex'), 1, n * 10
                FROM generate_series(1, 3) AS n`);
          }
        });
        const readRows = (db: PostgresSyncConnection) =>
          kind === "state"
            ? db
                .prepare(`SELECT session_id, started_at_ms FROM meeting_transcript_sessions
                  ORDER BY started_at_ms DESC NULLS LAST, session_id, started_at`)
                .all()
            : db
                .prepare(`SELECT hash, encode(embedding, 'hex') AS embedding, updated_at
                  FROM memory_embedding_cache ORDER BY hash`)
                .all();
        const expected =
          kind === "state"
            ? [
                { session_id: "session-3", started_at_ms: 30 },
                { session_id: "session-2", started_at_ms: 20 },
                { session_id: "session-1", started_at_ms: null },
              ]
            : [
                { hash: "hash-1", embedding: "0102", updated_at: 10 },
                { hash: "hash-2", embedding: "0102", updated_at: 20 },
                { hash: "hash-3", embedding: "0102", updated_at: 30 },
              ];
        expect(readRows(original)).toEqual(expected);
        const before = indexes(original);
        const changed =
          kind === "state"
            ? "idx_meeting_transcript_sessions_chronology"
            : "idx_memory_embedding_cache_updated_at";
        const unchanged =
          kind === "state"
            ? "idx_meeting_transcript_sessions_account"
            : "idx_agent_session_windows_conversation";
        expect(before.find((index) => index.name === changed)?.options).toBe(
          kind === "state" ? "1 2 2" : "2",
        );
        if (kind === "state") {
          expect(
            original.prepare("SELECT to_regclass('sandbox_persistent_execs') AS name").get(),
          ).toEqual({ name: null });
        }
        invalidate();
        const upgraded = open(target);
        expect(
          upgraded.prepare("SELECT version FROM openclaw_schema_meta WHERE store = ?").get(kind),
        ).toEqual({ version: target.version });
        expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: target.version,
        });
        expect(readRows(upgraded)).toEqual(expected);
        const after = indexes(upgraded);
        expect(after.map((index) => index.name)).toEqual(before.map((index) => index.name));
        expect(after.filter((index) => index.primary_key === 1)).toEqual(
          before.filter((index) => index.primary_key === 1),
        );
        for (const previous of before) {
          const current = after.find((index) => index.name === previous.name);
          if (current?.definition === previous.definition) {
            expect(current?.oid, String(previous.name)).toBe(previous.oid);
          } else {
            expect(current?.oid, String(previous.name)).not.toBe(previous.oid);
          }
        }
        expect(after.find((index) => index.name === changed)?.options).toBe(
          kind === "state" ? "1 0 0" : "0",
        );
        expect(after.find((index) => index.name === unchanged)).toEqual(
          before.find((index) => index.name === unchanged),
        );
        if (kind === "state") {
          const fragmentIndex = "idx_update_runs_created";
          expect(before.find((index) => index.name === fragmentIndex)?.options).toBe("1 2");
          expect(after.find((index) => index.name === fragmentIndex)?.options).toBe("3 0");
          expect(after.find((index) => index.name === fragmentIndex)?.oid).not.toBe(
            before.find((index) => index.name === fragmentIndex)?.oid,
          );
          expect(
            upgraded.prepare("SELECT to_regclass('sandbox_persistent_execs') AS name").get(),
          ).toEqual({ name: null });
        }
        invalidate();
        const statements: string[] = [];
        const observe = (event: unknown) => {
          if (isRecord(event) && event.engine === "postgres" && typeof event.sql === "string") {
            statements.push(event.sql);
          }
        };
        const observation = channel("openclaw.database.statement");
        observation.subscribe(observe);
        try {
          const reopened = open(target);
          expect(indexes(reopened)).toEqual(after);
          expect(readRows(reopened)).toEqual(expected);
          expect(statements.filter((sql) => /^\s*(?:CREATE|ALTER|DROP|DO)\b/iu.test(sql))).toEqual(
            [],
          );
        } finally {
          observation.unsubscribe(observe);
        }
      });
    },
  );
});
