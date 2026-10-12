import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  enrichAssistantTranscriptMediaForRun,
  publishAssistantTranscriptRewrite,
} from "../../gateway/server-methods/chat-transcript-persistence.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { createSessionWorkerOperationContext } from "./session-entry-patch.worker.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "./session-message-rewrite.js";
import {
  applySessionMessageRewrite,
  prepareSessionMessageRewrite,
} from "./session-message-rewrite.worker.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";

// mock-isolation: Keep unrelated periodic maintenance outside the exact-row writer fixture.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep history retention outside the exact-row writer fixture.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

function fixture(agentId = "main", storePath?: string) {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  const scope = {
    agentId,
    storePath: database.path,
    sessionKey: `agent:${agentId}:exact-rewrite`,
    sessionId: "exact-rewrite",
  };
  replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const [eventId, message] of [
    ["admission", { role: "user", content: "original" }],
    [
      "answer",
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        stopReason: "stop",
        __openclaw: { runId: "first-run" },
      },
    ],
    ["later", { role: "user", content: "later" }],
  ] as const) {
    expect(appendTranscriptMessageSync(scope, { eventId, message })).toMatchObject({ ok: true });
  }
  const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admission" });
  if (!anchor) {
    throw new Error("missing fixture anchor");
  }
  return {
    database,
    scope,
    anchor,
    rows: () => readTranscriptEventRows(database, scope.sessionId),
  };
}

it("returns the exact committed rewrite generation without selecting it again", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const selection = {
      scope: resolveSqliteTranscriptScope(f.scope),
      target: { kind: "anchor" as const, anchor: f.anchor },
    };
    const expected = prepareSessionMessageRewrite(selection, { open: () => f.database });
    assert(expected);
    const sql = trackSqliteStatementExecutions(f.database.db, ["generation"], (query) =>
      query.startsWith('select "generation" from "transcript_rewrite_watermarks"')
        ? "generation"
        : null,
    );
    let committedGeneration: string | undefined;
    try {
      const result = applySessionMessageRewrite(
        { ...selection, expected, message: { role: "user", content: "rewritten" } },
        createSessionWorkerOperationContext(
          f.database,
          { agentId: "main", path: f.database.path },
          { admit() {} },
          "Rewrite fixture",
        ),
        (_database, candidate) => candidate,
      );
      committedGeneration = result.result?.generation;
      expect(committedGeneration).toEqual(expect.any(String));
      expect(sql.counts.generation).toBe(0);
    } finally {
      sql.restore();
    }
    expect(
      f.database.db
        .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
        .get(f.scope.sessionId)?.generation,
    ).toBe(committedGeneration);
    const rewritten = f.rows().find((row) => JSON.parse(row.eventJson).id === "admission");
    assert(rewritten);
    expect(JSON.parse(rewritten.eventJson).message.content).toBe("rewritten");
  });
});

it.each([
  ["anchor", "main"],
  ["terminal", "main"],
  ["anchor", "secondary"],
  ["terminal", "secondary"],
] as const)(
  "rewrites the %s for logical %s without caller-thread SQL or changing later rows",
  async (operation, agentId) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = fixture(agentId, agentId === "main" ? undefined : state.statePath("shared.sqlite"));
      const before = f.rows();
      const sql = observeHostDataSql();
      try {
        if (operation === "anchor") {
          await expect(
            rewritePreparedTranscriptMessageAtAnchor(f.anchor, (message) => {
              if (!isRecord(message)) {
                throw new Error("invalid fixture message");
              }
              return { ...message, __openclaw: { steerTargetRunId: "next-run" } };
            }),
          ).resolves.toMatchObject({ message: { __openclaw: { steerTargetRunId: "next-run" } } });
        } else {
          await expect(
            enrichAssistantTranscriptMediaForRun({
              scope: f.scope,
              runId: "first-run",
              expectedLifecycleRevision: null,
              content: [{ type: "text", text: "display answer" }],
              mediaUrls: [],
            }),
          ).resolves.toEqual({ messageId: "answer" });
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      const after = f.rows();
      expect(after.at(-1)).toEqual(before.at(-1));
      expect(after).not.toEqual(before);
    });
  },
);

it.each(["payload", "lifecycle"] as const)(
  "refuses a stale %s after preparation with the original error class",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const source = f.rows().find((row) => JSON.parse(row.eventJson).id === "admission")!;
      await expect(
        rewritePreparedTranscriptMessageAtAnchor(
          f.anchor,
          (message) => {
            if (!isRecord(message)) {
              throw new Error("invalid fixture message");
            }
            if (change === "lifecycle") {
              replaceSessionEntrySync(f.scope, {
                sessionId: f.scope.sessionId,
                updatedAt: 2,
                lifecycleRevision: "successor",
              });
            } else {
              runOpenClawAgentWriteTransaction(
                (database) => {
                  rewriteSqliteTranscriptEventRowsInTransaction(
                    database,
                    resolveSqliteTranscriptScope(f.scope),
                    [
                      {
                        seq: source.seq,
                        expectedEventJson: source.eventJson,
                        event: {
                          ...JSON.parse(source.eventJson),
                          message: { ...message, content: "successor" },
                        },
                      },
                    ],
                  );
                },
                { agentId: "main", path: f.database.path },
              );
            }
            return { ...message, content: "stale replacement" };
          },
          { expectedEntry: { lifecycleRevision: null } },
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      const current = f.rows().find((row) => row.seq === source.seq)!;
      expect(JSON.parse(current.eventJson).message.content).toBe(
        change === "payload" ? "successor" : "original",
      );
    });
  },
);

it("preserves an inherited lifecycle fence when enriching a completion", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    replaceSessionEntrySync(f.scope, {
      sessionId: f.scope.sessionId,
      updatedAt: 2,
      activeWriterRunId: "first-run",
    });
    const before = f.rows();
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          ...f.scope,
          expectedWriterRunId: "first-run",
          expectedLifecycleRevision: "previous-lifecycle",
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        await expect(
          enrichAssistantTranscriptMediaForRun({
            scope: f.scope,
            runId: "first-run",
            expectedLifecycleRevision: null,
            content: [{ type: "text", text: "stale display" }],
            mediaUrls: [],
          }),
        ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      },
    );
    expect(f.rows()).toEqual(before);
  });
});

it.each([false, true])(
  "pins completion writes and publication across alias retargeting with stale writer %s",
  async (staleWriter) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const original = fixture("main", state.statePath("shared.main.sqlite"));
      const scope = { ...original.scope, storePath: state.statePath("shared.json") };
      expect(resolveSqliteTranscriptScope(scope).path).toBe(original.database.path);
      const identity = readOpenClawAgentDatabaseIdentity(original.database);
      const readSource = {
        agentId: "main",
        path: original.database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
      };
      replaceSessionEntrySync(original.scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        activeWriterRunId: staleWriter ? "successor-run" : "first-run",
      });
      const alternate = fixture("main", state.statePath("shared.sqlite"));
      replaceSessionEntrySync(alternate.scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        activeWriterRunId: "first-run",
      });
      expect(resolveSqliteTranscriptScope(scope).path).toBe(alternate.database.path);
      const originalBefore = original.rows();
      const alternateBefore = alternate.rows();
      const updates: unknown[] = [];
      const stop = onInternalSessionTranscriptUpdate((update) => updates.push(update));
      const sql = observeHostDataSql();
      try {
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: { ...scope, expectedWriterRunId: "first-run" },
            assertCommitAllowed: () => {},
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            const rewrite = enrichAssistantTranscriptMediaForRun({
              scope,
              readSource,
              runId: "first-run",
              expectedLifecycleRevision: null,
              content: [{ type: "text", text: "captured display" }],
              mediaUrls: [],
            });
            if (staleWriter) {
              await expect(rewrite).rejects.toBeInstanceOf(
                SessionTranscriptWriterClaimReboundError,
              );
            } else {
              const rewritten = await rewrite;
              expect(rewritten).toEqual({ messageId: "answer" });
              assert(rewritten);
              await publishAssistantTranscriptRewrite({
                scope,
                readSource,
                rewritten: [rewritten],
              });
            }
          },
        );
      } finally {
        sql.restore();
        stop();
      }
      expect(alternate.rows()).toEqual(alternateBefore);
      expect(readSessionEntryRow(alternate.database, scope.sessionKey)?.entry.updatedAt).toBe(1);
      if (staleWriter) {
        expect(original.rows()).toEqual(originalBefore);
        expect(updates).toEqual([]);
      } else {
        const answer = original.rows().find((row) => {
          const event: unknown = JSON.parse(row.eventJson);
          return isRecord(event) && event.id === "answer";
        });
        assert(answer);
        const event: unknown = JSON.parse(answer.eventJson);
        assert(isRecord(event) && isRecord(event.message));
        const message = event.message;
        expect(message.openclawDisplayContent).toEqual(
          expect.arrayContaining([{ type: "text", text: "captured display" }]),
        );
        expect(
          readSessionEntryRow(original.database, scope.sessionKey)?.entry.updatedAt,
        ).toBeGreaterThan(1);
        expect(updates).toEqual([
          expect.objectContaining({
            messageId: "answer",
            target: { ...original.scope, storePath: original.database.path },
          }),
        ]);
      }
      expect(sql.queries).toEqual([]);
    });
  },
);
