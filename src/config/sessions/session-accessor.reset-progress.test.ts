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

it.each([
  ["single", "clear", false],
  ["single", "clear", true],
  ["batched", "clear", false],
  ["batched", "clear", true],
  ["batched", "preserve-tail", false],
] as const)("%s %s reset owns the card lifetime (rollback=%s)", (writer, context, rollback) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
    const readCard = readSessionProgressCard.bind(null, database.db, sessionKey);
    const writeCard = writeSessionProgressCard.bind(null, database.db, sessionKey);
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
    writeCard({
      markdown: "Previous task",
      steps: [{ step: "Previous task", status: "in_progress" }],
    });
    const before = readCard();
    const invalidations: Array<[string | undefined, string, boolean]> = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      if (event.reason === "progress-card-reset") {
        invalidations.push([event.agentId, event.sessionKey, database.db.isTransaction]);
      }
    });
    const entry = {
      ...previous,
      ...(rollback ? { parentSessionKey: "invalid-reset-parent" } : {}),
      lifecycleRevision: "after",
      updatedAt: 2,
    };
    const resetBoundary = { context, reason: "reset" as const, cwd: state.workspaceDir };
    const reset = () =>
      writer === "single"
        ? resetSessionEntryLifecycle({
            agentId: "main",
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            resetBoundary,
            buildNextEntry: () => entry,
          })
        : applySessionEntryLifecycleMutation({
            agentId: "main",
            storePath,
            skipMaintenance: true,
            upserts: [{ sessionKey, entry, resetBoundary }],
          });
    try {
      if (rollback) {
        await expect(reset()).rejects.toThrow(
          "refusing non-canonical session key write invalid-reset-parent",
        );
        expect(loadSessionEntry(scope)).toEqual(entryBefore);
        expect(await loadTranscriptEvents(scope)).toEqual(historyBefore);
      } else {
        const sql = observeHostDataSql();
        using _ = { [Symbol.dispose]: sql.restore };
        await reset();
        expect(sql.queries, `${writer} reset caller-thread SQL`).toEqual([]);
      }
    } finally {
      unsubscribe();
    }
    // A fresh read-only connection proves this is durable state, not client/cache invalidation.
    {
      using reader = new DatabaseSync(database.path, { readOnly: true });
      expect(readSessionProgressCard(reader, sessionKey)).toEqual(
        context === "clear" && !rollback ? null : before,
      );
    }
    expect(await boards.getSnapshot({ sessionKey })).toEqual(boardBefore);
    expect((await readBoardHtml(boards, { sessionKey }, "retained-widget"))?.html).toBe(
      "<p>Keep this dashboard</p>",
    );
    if (context === "clear" && !rollback) {
      expect(readCard()).toBeNull();
      expect(invalidations).toEqual([["main", sessionKey, false]]);
      writeCard({ steps: [{ step: "Fresh task", status: "completed" }] });
      expect(readCard()?.revision).toBe(3);
      writeCard({ expectedRevision: before!.revision });
      expect(readCard()?.revision).toBe(3);
    } else {
      expect(readCard()).toEqual(before);
      expect(invalidations).toEqual([]);
    }
    expect(await loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({ id: "retained-message" }),
    );
  }),
);
