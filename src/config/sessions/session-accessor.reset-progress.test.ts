/** A fresh conversation must not inherit the prior task's progress card. */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readBoardHtml } from "../../boards/board-store.test-support.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

it.each(
  (["single", "batched"] as const).flatMap((writer) =>
    (["clear", "preserve-tail"] as const).flatMap((context) =>
      (context === "clear" ? [false, true] : [false]).map((rollback) => ({
        writer,
        context,
        rollback,
      })),
    ),
  ),
)(
  "$writer $context reset owns the card lifetime (rollback=$rollback)",
  async ({ writer, context, rollback }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:reset-progress";
      const sessionId = "same-reset-session";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { agentId: "main", sessionKey, sessionId, storePath };
      const previous = { sessionId, lifecycleRevision: "before", updatedAt: 1 };
      await upsertSessionEntryCore(scope, previous);
      appendTranscriptMessageSync(scope, {
        eventId: "retained-message",
        message: { role: "user", content: "Retain this history" },
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      });
      const boards = new SqliteBoardStore({
        resolveSession: () => ({ agentId: "main", path: database.path, sessionKey }),
      });
      await boards.putWidget({
        sessionKey,
        name: "retained-widget",
        content: { kind: "html", html: "<p>Keep this dashboard</p>" },
      });
      const boardBefore = await boards.getSnapshot({ sessionKey });
      const historyBefore = await loadTranscriptEvents(scope);
      const entryBefore = loadSessionEntry(scope);
      writeSessionProgressCard(database.db, sessionKey, {
        markdown: "Previous task",
        steps: [{ step: "Previous task", status: "in_progress" }],
      });
      const before = readSessionProgressCard(database.db, sessionKey);
      const invalidations: Array<{ agentId?: string; sessionKey: string; inTransaction: boolean }> =
        [];
      const unsubscribe = onSessionLifecycleEvent((event) => {
        if (event.reason === "progress-card-reset") {
          invalidations.push({
            agentId: event.agentId,
            sessionKey: event.sessionKey,
            inTransaction: database.db.isTransaction,
          });
        }
      });
      const entry = {
        ...previous,
        ...(rollback ? { parentSessionKey: "invalid-reset-parent" } : {}),
        lifecycleRevision: "after",
        updatedAt: 2,
      };
      const resetBoundary = { context, reason: "reset" as const, cwd: state.workspaceDir };
      const reset = async () => {
        if (writer === "single") {
          await resetSessionEntryLifecycle({
            agentId: "main",
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            resetBoundary,
            buildNextEntry: () => entry,
          });
        } else {
          await applySessionEntryLifecycleMutation({
            agentId: "main",
            storePath,
            skipMaintenance: true,
            upserts: [{ sessionKey, entry, resetBoundary }],
          });
        }
      };
      try {
        if (rollback) {
          await expect(reset()).rejects.toThrow(
            "refusing non-canonical session key write invalid-reset-parent",
          );
          expect(loadSessionEntry(scope)).toEqual(entryBefore);
          expect(await loadTranscriptEvents(scope)).toEqual(historyBefore);
        } else {
          const sql = writer === "batched" ? observeHostDataSql() : undefined;
          try {
            await reset();
            if (sql) {
              expect(sql.queries, "batched reset caller-thread SQL").toEqual([]);
            }
          } finally {
            sql?.restore();
          }
        }
      } finally {
        unsubscribe();
      }
      // A fresh read-only connection proves this is durable state, not client/cache invalidation.
      const reader = new DatabaseSync(database.path, { readOnly: true });
      try {
        expect(readSessionProgressCard(reader, sessionKey)).toEqual(
          context === "clear" && !rollback ? null : before,
        );
      } finally {
        reader.close();
      }
      expect(await boards.getSnapshot({ sessionKey })).toEqual(boardBefore);
      expect((await readBoardHtml(boards, { sessionKey }, "retained-widget"))?.html).toBe(
        "<p>Keep this dashboard</p>",
      );
      if (context === "clear" && !rollback) {
        expect(readSessionProgressCard(database.db, sessionKey)).toBeNull();
        expect(invalidations).toEqual([{ agentId: "main", sessionKey, inTransaction: false }]);
        writeSessionProgressCard(database.db, sessionKey, {
          steps: [{ step: "Fresh task", status: "completed" }],
        });
        expect(readSessionProgressCard(database.db, sessionKey)?.revision).toBe(3);
        writeSessionProgressCard(database.db, sessionKey, { expectedRevision: before!.revision });
        expect(readSessionProgressCard(database.db, sessionKey)?.revision).toBe(3);
      } else {
        expect(readSessionProgressCard(database.db, sessionKey)).toEqual(before);
        expect(invalidations).toEqual([]);
      }
      expect(await loadTranscriptEvents(scope)).toContainEqual(
        expect.objectContaining({ id: "retained-message" }),
      );
    });
  },
);
