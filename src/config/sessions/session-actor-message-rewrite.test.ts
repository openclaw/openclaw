import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  advanceSessionActorTranscriptReplica,
  readSessionActorTranscriptContext,
  seedSessionActorTranscriptContext,
} from "./session-actor-transcript-replica.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import {
  applySessionMessageRewrite,
  prepareSessionMessageRewrite,
} from "./session-message-rewrite.worker.js";
import { readSessionTranscriptAnchorFactsInDatabase } from "./session-transcript-anchor-read.kernel.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type { SessionMessageRewriteSelection } from "./session-transcript-mutation.types.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";

// mock-isolation: The fixture owns its database and transcript maintenance lifetime.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture controls retention rather than launching disk-budget maintenance.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const message = { role: "user", content: "Original question" };
const question = {
  type: "message",
  id: "question",
  parentId: null,
  timestamp: "2026-01-01T00:00:01Z",
  message,
};

function fixture(f: Fixture, pretty = false, sideEvents = 0) {
  const header = {
    type: "session",
    id: f.scope.sessionId,
    version: 3,
    timestamp: "2026-01-01T00:00:00Z",
    cwd: "/synthetic",
  };
  const eventJson = pretty ? JSON.stringify(question, null, 2) : JSON.stringify(question);
  runSqliteImmediateTransactionSync(f.database.db, () => {
    appendTranscriptEventInTransaction(f.database, f.scope, header);
    appendTranscriptEventInTransaction(f.database, f.scope, question, { eventJson });
    appendTranscriptEventsInTransaction(
      f.database,
      f.scope,
      Array.from({ length: sideEvents }, (_, index) => ({
        type: "custom",
        id: `side-${index}`,
        parentId: index === 0 ? question.id : `side-${index - 1}`,
        appendMode: "side",
        data: { synthetic: true },
      })),
      { scheduleProjectionReconcile: false },
    );
    if (sideEvents > 0) {
      reconcileSessionTranscriptIndexInTransaction(f.database.db, f.scope.sessionId);
    }
  });
  f.read();
  const anchor = readSessionTranscriptAnchorFactsInDatabase(f.database, f.scope, {
    entryIds: [question.id],
  }).anchors[0];
  assert(anchor);
  const selection: SessionMessageRewriteSelection = {
    scope: f.scope,
    target: { kind: "anchor", anchor, active: "exact" },
  };
  const context: AgentWorkerOperationContext = {
    open: () => f.database,
    options: { agentId: "main", path: f.database.path },
    admit() {},
    writeTransaction(_label, _owner, write) {
      return runSqliteImmediateTransactionSync(f.database.db, () => write(f.database));
    },
  };
  const prepare = () => {
    const expected = prepareSessionMessageRewrite(selection, context);
    assert(expected);
    return expected;
  };
  return {
    header,
    eventJson,
    selection,
    context,
    prepare,
    commit: (expected: ReturnType<typeof prepare>, next: unknown) =>
      applySessionMessageRewrite(
        { ...selection, expected, message: next },
        context,
        (_database, candidate) => candidate,
      ),
    rows: () => readTranscriptEventRows(f.database, f.scope.sessionId),
  };
}

it("reuses resident metadata while preserving exact payload bytes and observing the previous rewrite", async () => {
  await withActor((f) => {
    const rewrite = fixture(f, true);
    const sql = trackSqliteStatementExecutions(f.database.db, ["payload", "other"], (query) => {
      if (!/^select\b/i.test(query)) {
        return null;
      }
      return query.includes('as "event_json"') && query.includes('from "transcript_events"')
        ? "payload"
        : "other";
    });
    const firstMessage = { ...message, __openclaw: { steerTargetRunId: "first-run" } };
    const finalMessage = { ...message, __openclaw: { steerTargetRunId: "final-run" } };
    try {
      const first = rewrite.prepare();
      expect(first.eventJson).toBe(rewrite.eventJson);
      expect(rewrite.commit(first, firstMessage).result).toMatchObject({
        messageId: question.id,
        message: firstMessage,
      });
      expect(sql.counts).toEqual({ payload: 1, other: 0 });

      const second = rewrite.prepare();
      expect(second.event.message).toEqual(firstMessage);
      expect(second.eventJson).toBe(JSON.stringify({ ...question, message: firstMessage }));
      expect(rewrite.commit(second, finalMessage).result?.message).toEqual(finalMessage);
      expect(sql.counts).toEqual({ payload: 2, other: 0 });
    } finally {
      sql.restore();
    }
    expect(rewrite.rows().map((row) => JSON.parse(row.eventJson))).toEqual([
      rewrite.header,
      { ...question, message: finalMessage },
    ]);
  });
});

it("rewrites an active anchor older than the resident transcript window", async () => {
  await withActor((f) => {
    const rewrite = fixture(f, false, 520);
    const expected = rewrite.prepare();
    expect(expected.eventJson).toBe(rewrite.eventJson);
    const updated = { ...message, __openclaw: { steerTargetRunId: "historical-run" } };
    expect(rewrite.commit(expected, updated).result).toMatchObject({
      messageId: question.id,
      message: updated,
    });
    expect(rewrite.prepare().event.message).toEqual(updated);
    const rows = rewrite.rows();
    expect(rows).toHaveLength(522);
    expect(JSON.parse(rows[1]!.eventJson)).toEqual({ ...question, message: updated });
    expect(JSON.parse(rows.at(-1)!.eventJson)).toMatchObject({ id: "side-519" });
  });
});

it("rejects a prepared rewrite after another metadata edit without overwriting its payload", async () => {
  await withActor((f) => {
    const rewrite = fixture(f);
    const stale = rewrite.prepare();
    const winner = { ...message, __openclaw: { steerTargetRunId: "winner" } };
    rewrite.commit(rewrite.prepare(), winner);

    expect(() =>
      rewrite.commit(stale, { ...message, __openclaw: { steerTargetRunId: "stale" } }),
    ).toThrow(SessionTranscriptWriterClaimReboundError);
    expect(rewrite.rows().at(-1)?.eventJson).toBe(JSON.stringify({ ...question, message: winner }));
  });
});

it("rejects a reset between preparation and commit even when the replacement bytes match", async () => {
  await withActor((f) => {
    const rewrite = fixture(f);
    const expected = rewrite.prepare();
    runSqliteImmediateTransactionSync(f.database.db, () => {
      replaceSqliteTranscriptEventsInTransaction(f.database, f.scope, [rewrite.header, question]);
    });
    expect(rewrite.rows().at(-1)?.eventJson).toBe(expected.eventJson);

    expect(() =>
      rewrite.commit(expected, { ...message, __openclaw: { steerTargetRunId: "stale" } }),
    ).toThrow(SessionTranscriptWriterClaimReboundError);
    expect(rewrite.rows().at(-1)?.eventJson).toBe(expected.eventJson);
  });
});

it.each(["missing", "stale"] as const)(
  "rejects a %s anchor in the current resident facts",
  async (kind) => {
    await withActor((f) => {
      const rewrite = fixture(f);
      const target = rewrite.selection.target;
      assert(target.kind === "anchor");
      const anchor = {
        ...target.anchor,
        ...(kind === "missing"
          ? { entryId: "missing-message" }
          : { generation: "stale-generation" }),
      };
      expect(() =>
        prepareSessionMessageRewrite(
          { ...rewrite.selection, target: { ...target, anchor } },
          rewrite.context,
        ),
      ).toThrow(SessionTranscriptWriterClaimReboundError);
      expect(rewrite.rows().at(-1)?.eventJson).toBe(rewrite.eventJson);
    });
  },
);

function promptCarrier(f: Fixture, text: string) {
  const rewrite = fixture(f, true);
  const before = f.read();
  assert(rewrite.selection.target.kind === "anchor");
  const carrier = {
    type: "custom_message",
    id: "runtime-context",
    parentId: question.id,
    timestamp: "2026-01-01T00:00:02Z",
    customType: "openclaw.runtime-context",
    content: "Synthetic runtime context",
    display: false,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
  };
  const command: Mutation = {
    type: "session.actor.appendTranscriptEvent",
    input: {
      target: f.target,
      commandId: "runtime-context",
      phaseId: "turn",
      append: {
        kind: "metadata",
        modelPromptProjection: { anchor: rewrite.selection.target.anchor, text },
        input: {
          scope: f.scope,
          event: JSON.stringify(carrier),
          options: { expectedMutationAt: before.transcript.version.updatedAt },
          view: { loadedVersion: before.transcript.version },
        },
      },
    },
  };
  return { rewrite, before, carrier, command };
}

it.each([
  { text: "Original question", lostResponse: false },
  { text: "Final transformed question", lostResponse: true },
])("commits prompt capture and its carrier together ($text)", async ({ text, lostResponse }) => {
  await withActor(async (f) => {
    const { rewrite, before, carrier, command } = promptCarrier(f, text);
    const limits = { maxBytes: 10_000, maxEvents: 20 };
    let residentRows: Array<{ rawSeq: number; serializedBytes: number }> | undefined;
    const snapshot = readSessionTranscriptBoundedActiveContextCore(f.scope, {
      ...limits,
      onRead: (_projection, rows) => {
        residentRows = rows;
      },
    });
    const replica = seedSessionActorTranscriptContext(
      undefined,
      before,
      { kind: "bounded", snapshot, residentRows },
      limits,
    );
    await f.prepare(command);
    const sql = trackSqliteStatementExecutions(f.database.db, ["payload", "otherRead"], (query) =>
      /^select\b/i.test(query)
        ? query.includes('as "event_json"') && query.includes('from "transcript_events"')
          ? "payload"
          : "otherRead"
        : null,
    );
    const transactions = f.hooks.transactions;
    if (lostResponse) {
      f.hooks.afterTransaction = () => {
        throw new Error("synthetic lost response after commit");
      };
    }
    const outcome = (() => {
      try {
        return f.mutate(command);
      } finally {
        sql.restore();
        delete f.hooks.afterTransaction;
      }
    })();
    expect(f.hooks.transactions - transactions).toBe(1);
    expect(sql.counts).toEqual({ payload: 1, otherRead: 0 });
    assert(outcome.kind === "committed");
    const append = outcome.receipt.transcript.append;
    assert(append?.kind === "metadata" && append.value.snapshot.ok);
    expect(append.value.snapshot.value.before).toEqual(before.transcript.version);
    expect(append.value.reload).toBeUndefined();
    const projected = {
      ...message,
      __openclaw: { modelPromptProjection: { version: 1, text } },
    };
    const expectedEvents = [rewrite.header, { ...question, message: projected }, carrier];
    expect(append.modelPromptProjection?.result.message).toEqual(projected);
    expect(outcome.receipt.transcript.appendedEvents?.map((row) => row.event)).toEqual([carrier]);
    expect(
      readSessionActorTranscriptContext(
        advanceSessionActorTranscriptReplica(replica, outcome),
        outcome.receipt.postimage,
        limits,
      )?.snapshot.events,
    ).toEqual(expectedEvents);
    expect(
      outcome.receipt.transcript.after.generation === before.transcript.version.generation,
    ).toBe(text === message.content);
    if (lostResponse) {
      expect(outcome.failure?.message).toBe("synthetic lost response after commit");
    }
    f.restartActor();
    await f.reopenDatabase();
    expect(f.read().transcript.version).toEqual(outcome.receipt.transcript.after);
    expect(rewrite.rows().map((row) => JSON.parse(row.eventJson))).toEqual(expectedEvents);
  });
});

it.each(["stale-preimage", "commit-refused"] as const)(
  "rolls back both prompt capture and its carrier when %s",
  async (failure) => {
    await withActor(async (f) => {
      const { rewrite, before, command } = promptCarrier(f, "Final transformed question");
      assert("append" in command.input && command.input.append?.kind === "metadata");
      if (failure === "stale-preimage") {
        command.input.append.input.options.expectedMutationAt = -1;
      } else {
        f.hooks.admit = (stage) => {
          if (stage === "commit") {
            throw new Error("synthetic revoked append authority");
          }
        };
      }
      await f.prepare(command);
      expect(f.mutate(command)).toMatchObject({ kind: "rolled-back" });
      delete f.hooks.admit;
      expect(f.read().transcript.version).toEqual(before.transcript.version);
      f.restartActor();
      await f.reopenDatabase();
      expect(rewrite.rows().map((row) => JSON.parse(row.eventJson))).toEqual([
        rewrite.header,
        question,
      ]);
    });
  },
);
