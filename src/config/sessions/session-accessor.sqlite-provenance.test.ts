import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionEntry } from "./types.js";

const retainedPrompt = "retained skill prompt ".repeat(400);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createFixture() {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("session-provenance-") },
    sessionKey: "agent:main:provenance",
  };
  const database = openOpenClawAgentDatabase(scope);
  const entry: SessionEntry = {
    sessionId: "target",
    updatedAt: 20,
    skillsSnapshot: { prompt: retainedPrompt, skills: [] },
    pluginOwnerId: "plugin-owner",
    hookExternalContentSource: "webhook",
    acp: {
      backend: "acpx",
      agent: "test-agent",
      runtimeSessionName: "provenance-test",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 10,
    },
  };
  return { scope, database, entry, transcriptScope: { ...scope, sessionId: entry.sessionId } };
}

function trackTranscriptProbe(database: ReturnType<typeof openOpenClawAgentDatabase>) {
  return trackSqliteStatementExecutions(database.db, ["transcript"], (sql) =>
    /^select "seq" from "transcript_events" where "session_id" = \? limit \?$/i.test(sql)
      ? "transcript"
      : null,
  );
}

describe("SQLite session provenance writes", () => {
  it.each([
    ["new session", "absent", "absent", false, 1, 0],
    ["known provenance without hot rows", "known", "same", false, 1, 0],
    ["known provenance with hot rows", "known", "same", true, 1, 0],
    ["unknown same session without hot rows", "unknown", "same", false, 0, 0],
    ["unknown same session with hot rows", "unknown", "same", true, 0, 0],
    ["unknown absent entry without hot rows", "unknown", "absent", false, 1, 1],
    ["unknown absent entry with hot rows", "unknown", "absent", true, 0, 1],
    ["unknown different session without hot rows", "unknown", "different", false, 1, 1],
    ["unknown different session with hot rows", "unknown", "different", true, 0, 1],
  ] as const)(
    "preserves %s without redundant transcript reads",
    (_name, root, previous, hot, provenance, probes) => {
      const { scope, database, entry, transcriptScope } = createFixture();
      if (previous !== "absent") {
        replaceSessionEntrySync(scope, {
          ...entry,
          sessionId: previous === "same" ? entry.sessionId : "previous",
          updatedAt: 10,
        });
      }
      runOpenClawAgentWriteTransaction((db) => {
        if (root === "unknown") {
          ensureTranscriptSessionRoot(db, transcriptScope, 10);
          // Migrated windows have no trusted entry provenance, even when an entry survives.
          db.db
            .prepare(
              "UPDATE session_windows SET session_entry_provenance = 0, acp_owned = 0, plugin_owner_id = NULL, hook_external_content_source = NULL WHERE session_id = ?",
            )
            .run(entry.sessionId);
        }
        if (hot) {
          appendTranscriptEventInTransaction(db, transcriptScope, {
            type: "session",
            id: entry.sessionId,
            timestamp: 10,
          });
        }
      }, scope);

      const tracker = trackTranscriptProbe(database);
      let boundTextBytes = 0;
      const prepareStatement = database.db.prepare.bind(database.db);
      database.db.prepare = new Proxy(prepareStatement, {
        apply(prepare, receiver, args) {
          const statement = Reflect.apply(prepare, receiver, args);
          statement.run = new Proxy(statement.run.bind(statement), {
            apply(run, runReceiver, runArgs) {
              for (const value of runArgs) {
                if (typeof value === "string") {
                  boundTextBytes += Buffer.byteLength(value);
                }
              }
              return Reflect.apply(run, runReceiver, runArgs);
            },
          });
          return statement;
        },
      });
      try {
        // Exercise the real writer's previous-entry read; async patch fallbacks can supply a same-ID entry.
        replaceSessionEntrySync(
          scope,
          root === "known"
            ? { sessionId: entry.sessionId, updatedAt: 20, skillsSnapshot: entry.skillsSnapshot }
            : entry,
        );
        expect(boundTextBytes).toBeGreaterThan(0);
        expect(boundTextBytes).toBeLessThanOrEqual(Buffer.byteLength(retainedPrompt) * 1.5 + 4096);
        const stored = database.db
          .prepare("SELECT entry_json, entry_valid FROM session_nodes WHERE session_key = ?")
          .get(scope.sessionKey);
        expect(stored?.entry_valid).toBe(1);
        expect(JSON.parse(String(stored?.entry_json))).toMatchObject({
          sessionId: entry.sessionId,
          skillsSnapshot: entry.skillsSnapshot,
        });
        expect(tracker.counts.transcript).toBe(probes);
        expect(database.db.isTransaction).toBe(false);
        expect(
          database.db
            .prepare(
              "SELECT session_entry_provenance, acp_owned, plugin_owner_id, hook_external_content_source FROM session_windows WHERE session_id = ?",
            )
            .get(entry.sessionId),
        ).toEqual({
          session_entry_provenance: provenance,
          acp_owned: provenance,
          plugin_owner_id: provenance ? "plugin-owner" : null,
          hook_external_content_source: provenance ? "webhook" : null,
        });
      } finally {
        tracker.restore();
      }
    },
  );

  it.each(["transcript-first", "entry-first"] as const)(
    "resolves provenance in the original %s transaction order",
    (order) => {
      const { scope, database, entry, transcriptScope } = createFixture();
      const tracker = trackTranscriptProbe(database);
      const append = () =>
        appendTranscriptEventInTransaction(database, transcriptScope, {
          type: "session",
          id: entry.sessionId,
          timestamp: 10,
        });
      try {
        runOpenClawAgentWriteTransaction((db) => {
          if (order === "transcript-first") {
            append();
          }
          writeSessionEntry(db, scope.sessionKey, entry);
          if (order === "entry-first") {
            append();
          }
        }, scope);
        expect(tracker.counts.transcript).toBe(order === "transcript-first" ? 1 : 0);
        expect(
          database.db
            .prepare("SELECT session_entry_provenance FROM session_windows WHERE session_id = ?")
            .get(entry.sessionId),
        ).toEqual({
          session_entry_provenance: order === "transcript-first" ? 0 : 1,
        });
      } finally {
        tracker.restore();
      }
    },
  );
});
