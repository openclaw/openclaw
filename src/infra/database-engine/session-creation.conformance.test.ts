import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createSessionEntryWithTranscript,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import {
  deleteSessionEntryRows,
  readExactSessionEntryRow,
  writeSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { ensureTranscriptHeader } from "../../config/sessions/session-accessor.sqlite-transcript-header.js";
import { readSessionCreationOperationInWorker } from "../../config/sessions/session-creation-operation-read.js";
import { prepareSessionCreationOperation } from "../../config/sessions/session-creation-operation.js";
import { commitSessionCreationReceipt } from "../../config/sessions/session-creation-receipts.js";
import { agentEngineSchema } from "../../state/openclaw-agent-db-engine.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { usePostgresTestHarness } from "../postgres-sync/postgres.test-support.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { createPostgresEngineTestFixture } from "./engine-store.test-support.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const pg = usePostgresTestHarness("creation_migration");
beforeAll(async () => {
  if (pg.connection) {
    await pg.client.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
  }
});

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    engine + " durable creation owner",
    () => {
      const pair = useMixedAgentPair(engine, engine);
      it("commits receipt, row and transcript together and reconciles after owner restart", async () => {
        const now = Date.now();
        const hex = now.toString(16).padStart(12, "0");
        const sessionId = hex.slice(0, 8) + "-" + hex.slice(8) + "-7000-8000-000000000001";
        const key = "agent:main:dashboard:" + sessionId;
        const database = admit(() => openOpenClawAgentDatabase({ agentId: "main" }));
        expect(isPostgresSqlConnection(database.db)).toBe(engine === "postgres");
        const scope = { agentId: "main", sessionKey: key, storePath: database.path, sessionId };
        const operation = prepareSessionCreationOperation(
          "profile",
          "v1:" + now + ":" + "1".repeat(32),
          sessionId,
          { agentId: "main" },
          now,
        );
        const entry = { sessionId, lifecycleRevision: sessionId, updatedAt: now };
        expect(() =>
          admit(() =>
            runOpenClawAgentWriteTransaction(
              (writer) => {
                commitSessionCreationReceipt(writer, key, operation);
                ensureTranscriptHeader(writer, { ...scope, path: writer.path }, undefined);
                writeSessionEntry(writer, key, entry);
                throw new Error("synthetic rollback after all creation writes");
              },
              { agentId: "main", path: database.path },
            ),
          ),
        ).toThrow(/synthetic rollback/);
        admit(() => {
          expect(readExactSessionEntryRow(database, key)).toBeUndefined();
          expect(database.db.prepare("SELECT * FROM session_creation_operations").all()).toEqual(
            [],
          );
          expect(database.db.prepare("SELECT * FROM transcript_events").all()).toEqual([]);
        });
        // The fault probe used the admitted one-shot native handle. Retire it
        // there before exercising ordinary Gateway worker ownership.
        admit(() => closeOpenClawAgentDatabases(pair.root));
        expect(
          await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }), {
            creationOperation: operation,
          }),
        ).toMatchObject({ ok: true, entry });
        expect(await loadTranscriptEvents(scope)).toEqual([
          expect.objectContaining({ type: "session", id: sessionId }),
        ]);
        await closeOpenClawAgentDatabasesAsync(pair.root);
        expect(await readSessionCreationOperationInWorker(scope, operation)).toMatchObject({
          creationOperationMatched: true,
          existingEntry: entry,
        });
        const reopened = admit(() =>
          openOpenClawAgentDatabase({ agentId: "main", path: database.path }),
        );
        admit(() =>
          runOpenClawAgentWriteTransaction(
            (writer) => {
              expect(commitSessionCreationReceipt(writer, key, operation)).toBe(true);
            },
            { agentId: "main", path: reopened.path },
          ),
        );
        admit(() =>
          runOpenClawAgentWriteTransaction(
            (writer) => deleteSessionEntryRows(writer, key, { deleteOwnedWindows: true }),
            { agentId: "main", path: reopened.path },
          ),
        );
        await expect(readSessionCreationOperationInWorker(scope, operation)).rejects.toMatchObject({
          code: "creation-session-unavailable",
        });
        expect(
          admit(() =>
            reopened.db.prepare("SELECT session_id FROM session_creation_operations").all(),
          ),
        ).toEqual([{ session_id: sessionId }]);
      });
    },
  );
}

describe.skipIf(!mixedAgentConnection)("PostgreSQL creation receipt migration", () => {
  it("rolls back a failed v38 upgrade and preserves retained bytes on the successful upgrade", () =>
    admit(() => {
      const migration = expectDefined(
        agentEngineSchema.postgresMigrations?.find((step) => step.version === 39),
        "v39 migration",
      );
      const oldSchema = {
        ...agentEngineSchema,
        version: 38,
        postgres: migration.fromSchema.postgres,
        postgresMigrations: [],
      };
      using store = createPostgresEngineTestFixture({
        directory: pg.directories.make("creation-migration-"),
        connection: pg.connection!,
        schemaPrefix: pg.prefix,
        schema: oldSchema,
      });
      const before = store.open();
      before.exec(
        "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at) VALUES ('primary', 'agent', 38, 'main', 1, 1)",
      );
      before
        .prepare(
          "INSERT INTO cache_entries (scope, key, blob, updated_at) VALUES ('retained', 'bytes', ?, 1)",
        )
        .run(Buffer.from([0, 1, 255]));
      store.invalidate();
      expect(() =>
        store.open({
          ...agentEngineSchema,
          postgresMigrations: [
            {
              ...migration,
              sql: migration.sql + "; SELECT p7_synthetic_missing_relation FROM p7_missing",
            },
          ],
        }),
      ).toThrow();
      expect(before.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 38,
      });
      expect(
        before.prepare("SELECT to_regclass('session_creation_operations') AS receipt_table").get(),
      ).toEqual({ receipt_table: null });
      store.invalidate();
      const upgraded = store.open(agentEngineSchema);
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 39,
      });
      expect(upgraded.prepare("SELECT * FROM session_creation_operations").all()).toEqual([]);
      expect(
        upgraded.prepare("SELECT blob FROM cache_entries WHERE scope = 'retained'").get()?.blob,
      ).toEqual(new Uint8Array([0, 1, 255]));
      expect(() => store.open(oldSchema)).toThrow(/newer|version|migration/i);
    }));
});
