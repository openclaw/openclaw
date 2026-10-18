import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it as baseIt, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  enrichAssistantTranscriptMediaForRun,
  publishAssistantTranscriptRewrite,
} from "../../gateway/server-methods/chat-transcript-persistence.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import {
  rewriteAssistantTranscriptMessageForRun,
  rewriteTranscriptMessageAtAnchor,
} from "./session-accessor.transcript.js";
import { bindSessionWorkerBackend } from "./session-entry-patch.worker.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "./session-message-rewrite.js";
import {
  applySessionMessageRewrite,
  prepareSessionMessageRewrite,
} from "./session-message-rewrite.worker.js";
import type { SessionMessageRewriteCommitted } from "./session-transcript-mutation.types.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: [
    async ({ task: _task }, use) => withOpenClawTestState({ scenario: "minimal" }, use),
    { auto: true },
  ],
});

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
  const entry = (fields: Partial<Parameters<typeof replaceSessionEntrySync>[1]> = {}) =>
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1, ...fields });
  entry();
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
    entry,
    rows: () => readTranscriptEventRows(database, scope.sessionId),
    enrich: (
      text: string,
      options: Partial<Parameters<typeof enrichAssistantTranscriptMediaForRun>[0]> = {},
    ) =>
      enrichAssistantTranscriptMediaForRun({
        scope,
        runId: "first-run",
        expectedLifecycleRevision: null,
        content: [{ type: "text", text }],
        mediaUrls: [],
        ...options,
      }),
  };
}

function requireMessage(message: unknown) {
  assert(isRecord(message), "invalid fixture message");
  return message;
}

it("commits the exact prepared rewrite without rereading its payload or generation", async ({
  state,
}) => {
  const f = fixture();
  const selection = {
    scope: resolveSqliteTranscriptScope(f.scope),
    target: { kind: "anchor" as const, anchor: f.anchor },
  };
  const expected = prepareSessionMessageRewrite(selection, { open: () => f.database });
  assert(expected);
  const backend = runWithSqliteWorkerStateContext(
    { environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
    () =>
      bindSessionWorkerBackend<{
        rewrite: { input: null; output: SessionMessageRewriteCommitted };
      }>(
        { agentId: "main" },
        { database: f.database.db, databasePath: f.database.path, admit() {} },
        "Rewrite fixture",
        (context) => () =>
          applySessionMessageRewrite(
            { ...selection, expected, message: { role: "user", content: "rewritten" } },
            context,
            (_database, candidate) => candidate,
          ),
      ),
  );
  const sql = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(f.database.db),
    ["generation", "payload"],
    (query) =>
      query.startsWith('select "generation" from "transcript_rewrite_watermarks"')
        ? "generation"
        : query.startsWith("select ") && query.includes('as "event_json" from "transcript_events"')
          ? "payload"
          : null,
  );
  let committedGeneration: string | undefined;
  try {
    const result = backend.execute({ type: "rewrite", input: null });
    committedGeneration = result.result?.generation;
    expect(committedGeneration).toEqual(expect.any(String));
    expect(sql.counts).toEqual({ generation: 0, payload: 0 });
  } finally {
    sql.restore();
    await backend.close();
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

it.for([
  ["anchor", "main"],
  ["terminal", "main"],
  ["anchor", "secondary"],
  ["terminal", "secondary"],
] as const)(
  "rewrites the %s for logical %s without caller-thread SQL or changing later rows",
  async ([operation, agentId], { state }) => {
    const f = fixture(agentId, agentId === "main" ? undefined : state.statePath("shared.sqlite"));
    const before = f.rows();
    const sql = observeHostDataSql();
    try {
      if (operation === "anchor") {
        await expect(
          rewriteTranscriptMessageAtAnchor(f.anchor, (message) => {
            return { ...requireMessage(message), __openclaw: { steerTargetRunId: "next-run" } };
          }),
        ).resolves.toMatchObject({ message: { __openclaw: { steerTargetRunId: "next-run" } } });
      } else {
        await expect(
          rewriteAssistantTranscriptMessageForRun({
            scope: f.scope,
            runId: "first-run",
            expectedLifecycleRevision: null,
            rewriteMessage: (message) => ({
              ...message,
              openclawDisplayContent: [{ type: "text", text: "display answer" }],
            }),
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
  },
);

it.each([
  { change: "payload", replace: true },
  { change: "lifecycle", replace: true },
  { change: "payload", replace: false },
] as const)(
  "settles a prepared rewrite after a $change change (replacement: $replace)",
  async ({ change, replace }) => {
    const f = fixture();
    const source = f.rows().find((row) => JSON.parse(row.eventJson).id === "admission")!;
    const rewrite = rewritePreparedTranscriptMessageAtAnchor(
      f.anchor,
      (message) => {
        const current = requireMessage(message);
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
                      message: { ...current, content: "successor" },
                    },
                  },
                ],
              );
            },
            { agentId: "main", path: f.database.path },
          );
        }
        return replace ? { ...current, content: "stale replacement" } : undefined;
      },
      { expectedEntry: { lifecycleRevision: null } },
    );
    if (replace) {
      await expect(rewrite).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
    } else {
      await expect(rewrite).resolves.toBeNull();
    }
    const current = f.rows().find((row) => row.seq === source.seq)!;
    expect(JSON.parse(current.eventJson).message.content).toBe(
      change === "payload" ? "successor" : "original",
    );
  },
);

it("preserves an inherited lifecycle fence when enriching a completion", async () => {
  const f = fixture();
  f.entry({ updatedAt: 2, activeWriterRunId: "first-run" });
  const before = f.rows();
  await withOwnedSessionTranscriptWrites(
    {
      sessionTarget: {
        ...f.scope,
        expectedWriterRunId: "first-run",
        expectedLifecycleRevision: "previous-lifecycle",
      },
      withTranscriptWrite: async (write) => await write(),
    },
    async () => {
      await expect(f.enrich("stale display")).rejects.toBeInstanceOf(
        SessionTranscriptWriterClaimReboundError,
      );
    },
  );
  expect(f.rows()).toEqual(before);
});

it.for([false, true])(
  "pins completion writes and publication across alias retargeting with stale writer %s",
  async (staleWriter, { state }) => {
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
    original.entry({ activeWriterRunId: staleWriter ? "successor-run" : "first-run" });
    const alternate = fixture("main", state.statePath("shared.sqlite"));
    alternate.entry({ activeWriterRunId: "first-run" });
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
          assertCommitAllowed() {},
          withTranscriptWrite: async (write) => await write(),
        },
        async () => {
          const rewrite = original.enrich("captured display", { scope, readSource });
          if (staleWriter) {
            await expect(rewrite).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
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
  },
);
