import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readBoardHtml } from "../../boards/board-store.test-support.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import {
  readSessionProgressCard,
  readSessionProgressAggregate,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as sessions from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.kernel.js";
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
    const cleared = context === "clear" && !rollback;
    const previous = { sessionId, lifecycleRevision: "before", updatedAt: 1 };
    await sessions.upsertSessionEntryCore(scope, previous);
    appendTranscriptMessageSync(scope, {
      eventId: "retained-message",
      message: { role: "user", content: "history" },
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
      name: "widget",
      content: { kind: "html", html: "<p>kept</p>" },
    });
    const boardBefore = await boards.getSnapshot({ sessionKey });
    const historyBefore = await sessions.loadTranscriptEvents(scope);
    const entryBefore = sessions.loadSessionEntry(scope);
    writeCard({
      markdown: "old",
      steps: [{ step: "old", status: "in_progress" }],
      workCommand: {
        kind: "begin",
        display: "replace",
        scope: "Retained reset work",
        expected: null,
        owner: { agentId: "main", sessionKey, sessionId, lifecycleRevision: "before" },
        source: {
          runId: "reset-proof",
          turnId: "turn",
          toolCallId: "plan",
          processGeneration: "process",
        },
      },
    });
    const workBefore = readSessionProgressAggregate(database.db, sessionKey)?.work;
    const before = readCard();
    const invalidations: Array<[string | undefined, string, boolean]> = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      if (event.reason === "progress-card-reset") {
        invalidations.push([event.agentId, event.sessionKey, database.db.isTransaction]);
      }
    });
    const entry = {
      ...previous,
      ...(rollback ? { parentSessionKey: "invalid" } : {}),
      lifecycleRevision: "after",
      updatedAt: 2,
    };
    const resetBoundary = { context, reason: "reset" as const, cwd: state.workspaceDir };
    const reset = () =>
      writer === "single"
        ? sessions.resetSessionEntryLifecycle({
            agentId: "main",
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            resetBoundary,
            buildNextEntry: () => entry,
          })
        : sessions.applySessionEntryLifecycleMutation({
            agentId: "main",
            storePath,
            skipMaintenance: true,
            upserts: [{ sessionKey, entry, resetBoundary }],
          });
    try {
      if (rollback) {
        await expect(reset()).rejects.toThrow("refusing non-canonical session key write invalid");
        expect(sessions.loadSessionEntry(scope)).toEqual(entryBefore);
        expect(await sessions.loadTranscriptEvents(scope)).toEqual(historyBefore);
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
      expect(readSessionProgressCard(reader, sessionKey)).toEqual(cleared ? null : before);
    }
    const workAfter = readSessionProgressAggregate(database.db, sessionKey)?.work;
    if (rollback) {
      expect(workAfter).toEqual(workBefore);
    } else if (cleared) {
      expect(workAfter).toMatchObject({ generation: 1, revision: 2, record: null });
    } else {
      expect(workAfter).toMatchObject({
        generation: 1,
        revision: 2,
        record: {
          owner: { lifecycleRevision: "after" },
          steps: [{ step: "old", status: "in_progress" }],
        },
      });
    }
    expect(await boards.getSnapshot({ sessionKey })).toEqual(boardBefore);
    expect((await readBoardHtml(boards, { sessionKey }, "widget"))?.html).toBe("<p>kept</p>");
    expect(readCard()).toEqual(cleared ? null : before);
    expect(invalidations).toEqual(cleared ? [["main", sessionKey, false]] : []);
    if (cleared) {
      writeCard({ steps: [{ step: "Fresh task", status: "completed" }] });
      expect(readCard()?.revision).toBe(3);
      writeCard({ expectedRevision: before!.revision });
      expect(readCard()?.revision).toBe(3);
    }
    expect(await sessions.loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({ id: "retained-message" }),
    );
  }),
);
