import { describe, expect, it, vi } from "vitest";
import { appendSessionTranscriptReport } from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { readSessionTranscriptJsonlBytesInDatabase } from "../../config/sessions/session-accessor.sqlite-maintenance-store.js";
import { readCurrentProjectionSnapshot } from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import { readVisibleTranscriptStats } from "../../config/sessions/session-accessor.sqlite-reset-window.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptStatsFromDatabase } from "../../config/sessions/session-accessor.sqlite-transcript-stats.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { executeSqliteQuerySync } from "../kysely-sync.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const scopeFor = (sessionId: string) => ({
  agentId: "main",
  sessionKey: `agent:main:${sessionId}`,
  sessionId,
});
const message = (id: string, parentId: string | null, role: string, content: string) => ({
  type: "message",
  id,
  parentId,
  message: { role, content },
});
function withTranscript(
  scope: ReturnType<typeof scopeFor>,
  events: unknown[],
  inspect: (database: OpenClawAgentDatabase, resolved: ResolvedTranscriptScope) => void,
) {
  withEngineStoreAdmission(() => {
    const resolved = resolveSqliteTranscriptScope(scope);
    runOpenClawAgentWriteTransaction((database) => {
      writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
      replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
      inspect(database, resolved);
    }, toDatabaseOptions(resolved));
  });
}

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s transcript report navigation",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("returns numeric transcript bytes for raw, reset-tail, and maintenance reads", () => {
      const scope = scopeFor("transcript-byte-counts");
      const kept = message("kept", "discarded", "user", "Retained λ🦞 preference.");
      const tail = message("tail", "reset", "assistant", "Fresh 日本語 response.");
      const events = [
        { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
        message("discarded", null, "user", "Discarded earlier context."),
        kept,
        { type: "reset", id: "reset", parentId: "kept", firstKeptEntryId: "kept", reason: "new" },
        tail,
      ];
      const bytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event));
      const payloadBytes = events.reduce((total, event) => total + bytes(event), 0);
      withTranscript(scope, events, (database, resolved) => {
        expect(readTranscriptStatsFromDatabase(database, scope.sessionId)).toMatchObject({
          eventCount: events.length,
          sizeBytes: payloadBytes + events.length - 1,
        });
        expect(
          readSessionTranscriptJsonlBytesInDatabase(database, [scope.sessionId, "missing"]),
        ).toEqual(new Map([[scope.sessionId, payloadBytes + events.length]]));
        const visible = readCurrentProjectionSnapshot(database, resolved, (projection) =>
          // Cold projections reconstruct the retained prefix without cached accounting facts.
          readVisibleTranscriptStats({
            ...projection,
            contextMetadata: undefined,
            contextStats: undefined,
          }),
        );
        expect(visible).toMatchObject({
          kind: "value",
          value: { eventCount: 2, sizeBytes: bytes(kept) + bytes(tail) + 2 },
        });
      });
    });

    it("selects the latest custom report from persisted transcript navigation", async () => {
      const scope = scopeFor("report-navigation");
      const content = "synthetic report content ".repeat(400);
      const selected = { customType: "status", content, details: { selected: true } };
      withTranscript(
        scope,
        [
          { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
          message("root", null, "user", content),
          { type: "custom_message", id: "selected", parentId: "root", ...selected, display: true },
        ],
        (database) => {
          const rows = executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("transcript_events")
              .select(["event_json", "event_zstd"])
              .where("session_id", "=", scope.sessionId),
          ).rows;
          // SQLite uses zstd navigation; PostgreSQL keeps canonical JSON and delegates to TOAST.
          expect(
            rows.filter((row) => row.event_json === null && row.event_zstd !== null),
          ).toHaveLength(engine === "sqlite" ? 2 : 0);
        },
      );
      const selectReport = vi.fn();
      await expect(
        appendSessionTranscriptReport(scope, {
          kind: "custom",
          customTypes: ["status"],
          selectReport,
        }),
      ).resolves.toEqual({ ok: true, value: undefined });
      expect(selectReport).toHaveBeenCalledExactlyOnceWith(selected);
    });
  },
);
