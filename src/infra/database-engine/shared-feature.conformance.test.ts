import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OutboundMessageProgressInput } from "../../audit/audit-event-types.js";
import { recordOutboundMessageProgressInDatabase } from "../../audit/message-delivery-progress-store.js";
import {
  configHealthReadOperations,
  patchConfigHealthEntryInDatabase,
} from "../../config/io.health-state.kernel.js";
import { isMissingPluginStateTableError } from "../../plugin-state/plugin-state-store.database.js";
import { DebugProxyCaptureKernel } from "../../proxy-capture/store.kernel.js";
import { recordSessionStateEventsInDatabase } from "../../sessions/session-state-events.kernel.js";
import {
  readAgentProvenanceBatchInDatabase,
  recordAgentProvenanceInDatabase,
} from "../../state/agent-provenance.kernel.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { preparePostgresQuery } from "../postgres-sync/protocol.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

function captureProgressInsert() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("feature-conformance-") } };
  const database = openOpenClawStateDatabase(options);
  const prepare = database.db.prepare.bind(database.db);
  let captured: { sql: string; parameters: SQLInputValue[] } | undefined;
  vi.spyOn(database.db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('insert into "outbound_message_progress"')) {
      const capture = (parameters: SQLInputValue[]) => {
        captured = { sql, parameters };
      };
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation(
        new Proxy(all, {
          apply(target, receiver, parameters) {
            capture(parameters);
            return Reflect.apply(target, receiver, parameters);
          },
        }),
      );
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation(
        new Proxy(iterate, {
          apply(target, receiver, parameters) {
            capture(parameters);
            return Reflect.apply(target, receiver, parameters);
          },
        }),
      );
    }
    return statement;
  });
  const input: OutboundMessageProgressInput = {
    sourceId: "conformance-progress",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "message",
    action: "message.outbound.queued",
    status: "started",
    outcome: "queued",
    actorType: "agent",
    actorId: "main",
    direction: "outbound",
    channel: "conformance",
    conversationKind: "direct",
  };
  expect(recordOutboundMessageProgressInDatabase(input, { ...options, database })).toMatchObject({
    action: input.action,
    sequence: 1,
  });
  assert(captured, "The progress owner must execute its insert");
  return captured;
}

it.skipIf(!connection)(
  "prepares shared feature SQL against generated PostgreSQL DDL and preserves owner results",
  () => {
    const progress = captureProgressInsert();
    withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(":memory:");
      const namespace = `features_${randomUUID().replaceAll("-", "")}`;
      const remote = new PostgresSyncConnection(connection!, namespace, anchor, namespace);
      // Shared feature signatures retain DatabaseSync until the separate state-owner cutover.
      // @ts-expect-error -- The bridge intentionally omits SQLite-only methods.
      const db: DatabaseSync = remote;
      try {
        remote.exec(`CREATE SCHEMA "${namespace}"`);
        for (const file of [
          "state.postgres.sql",
          "fragment-agent_provenance.postgres.sql",
          "fragment-outbound_message_progress.postgres.sql",
        ]) {
          remote.exec(
            readFileSync(
              new URL(`../../state/postgres-schema.generated/${file}`, import.meta.url),
              "utf8",
            ),
          );
        }
        const query = remote.query.bind(remote);
        const prepared = new Set<string>();
        vi.spyOn(remote, "query").mockImplementation(
          (sql, parameters = [], readBigInts = false) => {
            // PREPARE the actual owner statement, then execute it normally with its bound values.
            // This adds parser/type-inference proof without maintaining a second SQL implementation.
            if (/^(?:insert|select)\b/i.test(sql) && !prepared.has(sql)) {
              query(`PREPARE feature_statement AS ${preparePostgresQuery(sql).sql}`);
              query("DEALLOCATE feature_statement");
              prepared.add(sql);
            }
            return query(sql, parameters, readBigInts);
          },
        );

        // Shared-state opening is a separate cutover: replay this real owner insert only.
        const progressInsert = remote.prepare(progress.sql);
        expect(progressInsert.all(...progress.parameters)).toEqual([{ sequence: 1 }]);
        expect(progressInsert.all(...progress.parameters)).toEqual([]);
        expect(
          remote.query("SELECT count(*) AS count FROM outbound_message_progress").rows,
        ).toEqual([{ count: 1 }]);

        const configPath = "/synthetic/openclaw.json";
        const observedJson = '{ "hash": "observed" }';
        const promotedJson = '{"hash":"promoted"}';
        const readHealthBasis = () =>
          configHealthReadOperations["config.health.read"](undefined, remote).snapshot.basis[
            configPath
          ];
        expect(
          patchConfigHealthEntryInDatabase(
            remote,
            configPath,
            { last_known_good_json: observedJson },
            null,
            100,
          ),
        ).toBe(true);
        const observed = readHealthBasis();
        expect(observed).toEqual({
          lastKnownGoodJson: observedJson,
          lastPromotedGoodJson: null,
          suspiciousSignature: null,
          updatedAtMs: 100,
        });
        expect(
          patchConfigHealthEntryInDatabase(
            remote,
            configPath,
            {
              last_promoted_good_json: promotedJson,
              last_observed_suspicious_signature: "observed-signature",
            },
            observed,
            100,
          ),
        ).toBe(true);
        const promoted = readHealthBasis();
        assert(promoted);
        expect(promoted).toEqual({
          lastKnownGoodJson: observedJson,
          lastPromotedGoodJson: promotedJson,
          suspiciousSignature: "observed-signature",
          updatedAtMs: 100,
        });
        const clearHealth = {
          last_known_good_json: null,
          last_promoted_good_json: null,
          last_observed_suspicious_signature: null,
        };
        for (const stale of [
          { ...promoted, lastKnownGoodJson: '{"hash":"observed"}' },
          { ...promoted, lastPromotedGoodJson: null },
          { ...promoted, suspiciousSignature: null },
        ]) {
          expect(
            patchConfigHealthEntryInDatabase(remote, configPath, clearHealth, stale, 200),
          ).toBe(false);
        }
        expect(readHealthBasis()).toEqual(promoted);
        expect(
          patchConfigHealthEntryInDatabase(remote, configPath, clearHealth, promoted, 200),
        ).toBe(true);
        const cleared = readHealthBasis();
        expect(cleared).toEqual({
          lastKnownGoodJson: null,
          lastPromotedGoodJson: null,
          suspiciousSignature: null,
          updatedAtMs: 200,
        });
        expect(
          patchConfigHealthEntryInDatabase(
            remote,
            configPath,
            { last_known_good_json: observedJson },
            cleared,
            300,
          ),
        ).toBe(true);

        const input = {
          sessionKey: "agent:main:conformance",
          agentId: "main",
          kind: "created" as const,
          actorType: "system" as const,
          summary: "Created",
          dedupeKey: "conformance-event",
        };
        const first = runSqliteImmediateTransactionSync(db, () =>
          recordSessionStateEventsInDatabase(db, [{ event: input, now: 100 }]),
        );
        expect(first.rows[0]).toMatchObject({ sequence: 1, summary: "Created" });
        expect(
          remote.query("SELECT last_sequence, updated_at FROM session_state_heads").rows,
        ).toEqual([{ last_sequence: 1, updated_at: 100 }]);
        const duplicate = runSqliteImmediateTransactionSync(db, () =>
          recordSessionStateEventsInDatabase(db, [
            { event: { ...input, summary: "Ignored" }, now: 200 },
          ]),
        );
        expect(duplicate).toEqual(first);
        expect(
          remote.query("SELECT last_sequence, updated_at FROM session_state_heads").rows,
        ).toEqual([{ last_sequence: 1, updated_at: 100 }]);

        const batch = runSqliteImmediateTransactionSync(db, () =>
          recordSessionStateEventsInDatabase(db, [
            { event: { ...input, dedupeKey: "batch-main-first" }, now: 300 },
            { event: { ...input, agentId: "other", dedupeKey: "batch-other" }, now: 400 },
            { event: { ...input, dedupeKey: "batch-main-last" }, now: 500 },
            { event: input, now: 600 },
          ]),
        );
        expect(batch.rows).toHaveLength(4);
        expect(
          remote.query(
            "SELECT agent_id, last_sequence, updated_at FROM session_state_heads ORDER BY agent_id",
          ).rows,
        ).toEqual([
          { agent_id: "main", last_sequence: batch.rows[2]!.sequence, updated_at: 500 },
          { agent_id: "other", last_sequence: batch.rows[1]!.sequence, updated_at: 400 },
        ]);

        for (const agentId of ["alpha", "beta"]) {
          recordAgentProvenanceInDatabase(db, {
            agentId,
            createdVia: "operator",
            creatorAgentId: null,
            createdAtMs: 100,
          });
        }
        expect(
          readAgentProvenanceBatchInDatabase(db, ["BETA", "missing", "alpha", "beta"]).map(
            (row) => row.agentId,
          ),
        ).toEqual(["beta", "alpha", "beta"]);
        const capture = new DebugProxyCaptureKernel({
          db,
          dbPath: ":memory:",
          blobDir: "unused",
          runWrite: (operation) => runSqliteImmediateTransactionSync(db, operation),
        });
        const blob = capture.persistPayload(Buffer.from("synthetic payload"), "text/plain");
        expect(
          capture.persistPayload(Buffer.from("synthetic payload"), "application/json").blobId,
        ).toBe(blob.blobId);
        for (const ts of [100, 200]) {
          capture.recordEvent({
            sessionId: "conformance-capture",
            ts,
            sourceScope: "openclaw",
            sourceProcess: "conformance",
            protocol: "http",
            direction: "outbound",
            kind: "request",
            flowId: `flow-${ts}`,
            dataBlobId: blob.blobId,
          });
        }
        expect(capture.readBlob(blob.blobId)).toBe("synthetic payload");
        expect(remote.query("SELECT content_type FROM capture_blobs").rows).toEqual([
          { content_type: "text/plain" },
        ]);
        expect(remote.query("SELECT started_at FROM capture_sessions").rows).toEqual([
          { started_at: 100 },
        ]);
        expect(capture.getSessionEvents("conformance-capture")).toHaveLength(2);

        remote.exec("DROP TABLE plugin_state_entries");
        let missingTableError: unknown;
        try {
          remote.query("SELECT * FROM plugin_state_entries");
        } catch (error) {
          missingTableError = error;
        }
        expect(isMissingPluginStateTableError(missingTableError)).toBe(true);
      } finally {
        try {
          remote.exec(`DROP SCHEMA "${namespace}" CASCADE`);
        } finally {
          remote.close();
        }
      }
    });
  },
);
