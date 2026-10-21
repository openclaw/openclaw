import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createReadonlySessionHistoryReader } from "../../gateway/session-history-readonly-reader.js";
import {
  OpenClawAgentDatabaseReadOnlyScope,
  withScopedOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { replaceSessionEntry, waitForSessionTranscriptProjection } from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";

it.each([false, true])(
  "bounds legacy coordination lookups and reuses scanned inputs (compacted=%s)",
  async (compacted) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionId: "bounded-coordination-history",
        sessionKey: "agent:main:dashboard:bounded-coordination-history",
        storePath: database.path,
      };
      const provenance = {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceRole: "subagent",
      };
      const user = (content: string, fields: Record<string, unknown>) => ({
        role: "user",
        content,
        ...fields,
      });
      const answer = (runId: string) => ({
        role: "assistant",
        content: "reply",
        __openclaw: { runId },
      });
      const steering = { __openclaw: { steerTargetRunId: "steered-run" } };
      const messages = [
        user("report", { idempotencyKey: "quiet-run:user", provenance }),
        answer("quiet-run"),
        user("report", { idempotencyKey: "steered-run:user", provenance }),
        answer("steered-run"),
        user("Counted hidden steering input", { ...steering, provenance }),
        answer("steered-run"),
        user("human steering", steering),
        answer("steered-run"),
        user("ordinary input", { idempotencyKey: "visible-run:user" }),
        answer("visible-run"),
        ...Array.from({ length: 2_000 }, (_, index) => ({
          role: "user",
          content: `Unrelated later input ${index}`,
          idempotencyKey: `later-run-${index}:user`,
        })),
      ];
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const events: Parameters<typeof replaceTranscriptEvents>[1] = [
        { type: "session", version: 3, id: scope.sessionId },
        ...messages.map((message, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId:
            index === 0 ? null : compacted && index === 1 ? "compaction" : `message-${index - 1}`,
          message,
        })),
      ];
      if (compacted) {
        events.splice(2, 0, {
          type: "compaction",
          id: "compaction",
          parentId: "message-0",
          firstKeptEntryId: "message-0",
          summary: "Retained worker report",
        });
      }
      for (let index = 0; index < 16; index++) {
        events.push({
          type: "custom_message",
          id: `later-marker-${index}`,
          parentId: index === 0 ? `message-${messages.length - 1}` : `later-marker-${index - 1}`,
          customType: "display-report",
          display: true,
          content: "Unrelated later marker",
        });
      }
      await replaceTranscriptEvents(scope, events);
      await waitForSessionTranscriptProjection(scope);
      if (compacted) {
        runOpenClawAgentWriteTransaction(
          (writeDatabase) =>
            writeDatabase.db
              .prepare(`UPDATE transcript_events
            SET navigation_type = NULL, navigation_custom_type = NULL,
                navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
                navigation_last_custom_type = NULL, navigation_valid = 1
            WHERE session_id = ?`)
              .run(scope.sessionId),
          { agentId: database.agentId, path: database.path },
        );
      }

      const nativeJson = new DatabaseSync(":memory:");
      // JSONB preserves nested JSON values across the counting callback's SQL boundary.
      const extractJson = nativeJson.prepare("SELECT jsonb_extract(?, ?) AS value");
      let laterInputInspections = 0;
      let hiddenSteerInspections = 0;
      const retained = new OpenClawAgentDatabaseReadOnlyScope();
      const target = { agentId: "main", path: database.path };
      try {
        retained.run(target, () => {
          const opened = withScopedOpenClawAgentDatabaseReadOnly((reader) => reader, target);
          if (!opened.found) {
            throw new Error("Expected the seeded history reader");
          }
          const nativeDb = requireNativeSqliteDatabase(opened.value.db);
          nativeDb.function("json_extract", { deterministic: true }, (value, jsonPath) => {
            if (jsonPath === "$.message.role" && typeof value === "string") {
              laterInputInspections += Number(value.includes("Unrelated later input"));
              hiddenSteerInspections += Number(value.includes("Counted hidden steering input"));
            }
            return extractJson.get(value, jsonPath)?.value ?? null;
          });
          const resolver = createReadonlySessionHistoryReader({
            transcript: { ...scope, sessionFile: scope.sessionKey },
            database: target,
          }).subagentCoordination;
          const classify = (seq: number, runId = "steered-run") =>
            resolver.isSubagentRunMessage(runId, seq + Number(compacted));
          expect(classify(2, "quiet-run")).toBe(true);
          expect(laterInputInspections).toBe(0);
          expect(hiddenSteerInspections).toBe(0);
          expect(classify(4)).toBe(true);
          expect(hiddenSteerInspections).toBe(0);
          expect(classify(6)).toBe(true);
          const inspectedHiddenSteer = hiddenSteerInspections;
          expect(inspectedHiddenSteer).toBeGreaterThan(0);
          expect([classify(4), classify(8), classify(4)]).toEqual([true, false, true]);
          expect(hiddenSteerInspections).toBe(inspectedHiddenSteer);
          expect(laterInputInspections).toBe(0);
          const reads = trackSqliteStatementExecutions(nativeDb, ["selected"], (sql) =>
            /^select\b/i.test(sql.trimStart()) ? "selected" : null,
          );
          try {
            expect(classify(10, "visible-run")).toBe(false);
            // An ordinary input needs only its own facts, regardless of later display markers.
            expect(reads.rowCounts.selected).toBeLessThanOrEqual(8);
          } finally {
            reads.restore();
          }
        });
      } finally {
        retained.close();
        nativeJson.close();
      }
    });
  },
);
