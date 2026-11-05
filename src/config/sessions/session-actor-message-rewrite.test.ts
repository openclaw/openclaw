import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import {
  applySessionMessageRewrite,
  prepareSessionMessageRewrite,
} from "./session-message-rewrite.worker.js";
import { readSessionTranscriptAnchorFactsInDatabase } from "./session-transcript-anchor-read.kernel.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type { SessionMessageRewriteSelection } from "./session-transcript-mutation.types.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import { timedMessageEvent } from "./transcript-message.test-support.js";

// mock-isolation: The fixture owns its database and transcript maintenance lifetime.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture controls retention rather than launching disk-budget maintenance.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const message = { role: "user", content: "Original question" };
const question = timedMessageEvent("question", null, "2026-01-01T00:00:01Z", message);

function fixture(f: Fixture, sideEvents = 0) {
  const header = {
    type: "session",
    id: f.scope.sessionId,
    version: 3,
  };
  const eventJson = JSON.stringify(question);
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
  const selection = {
    scope: f.scope,
    target: { kind: "anchor", anchor, active: "exact" },
  } satisfies SessionMessageRewriteSelection;
  const context: AgentWorkerOperationContext = {
    open: () => f.database,
    options: { agentId: "main", path: f.database.path },
    admit() {},
    writeTransaction(_label, _owner, write) {
      return runSqliteImmediateTransactionSync(f.database.db, () => write(f.database));
    },
  };
  const prepare = (target = selection.target) => {
    const expected = prepareSessionMessageRewrite({ ...selection, target }, context);
    assert(expected);
    return expected;
  };
  return {
    header,
    eventJson,
    selection,
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

it("rewrites an active anchor older than the resident transcript window", () =>
  withActor((f) => {
    const rewrite = fixture(f, 520);
    const expected = rewrite.prepare();
    expect(expected.eventJson).toBe(rewrite.eventJson);
    const updated = { ...message, __openclaw: { steerTargetRunId: "historical-run" } };
    rewrite.commit(expected, updated);
    expect(rewrite.prepare().event.message).toEqual(updated);
    const rows = rewrite.rows();
    expect(rows).toHaveLength(522);
    expect(JSON.parse(rows[1]!.eventJson)).toEqual({ ...question, message: updated });
    expect(JSON.parse(rows.at(-1)!.eventJson)).toMatchObject({ id: "side-519" });
  }));

it("rejects a reset between preparation and commit even when the replacement bytes match", () =>
  withActor((f) => {
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
  }));

it("rejects a missing anchor in the current resident facts", () =>
  withActor((f) => {
    const rewrite = fixture(f);
    const target = rewrite.selection.target;
    expect(() =>
      rewrite.prepare({ ...target, anchor: { ...target.anchor, entryId: "missing-message" } }),
    ).toThrow(SessionTranscriptWriterClaimReboundError);
    expect(rewrite.rows().at(-1)?.eventJson).toBe(rewrite.eventJson);
  }));

function promptCarrier(f: Fixture, text: string) {
  const rewrite = fixture(f);
  const before = f.read();
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
])("commits prompt capture and its carrier together ($text)", ({ text, lostResponse }) =>
  withActor(async (f) => {
    const { rewrite, before, carrier, command } = promptCarrier(f, text);
    await f.prepare(command);
    if (lostResponse) {
      f.hooks.afterTransaction = () => {
        throw new Error("synthetic lost response after commit");
      };
    }
    const outcome = f.mutate(command);
    delete f.hooks.afterTransaction;
    assert(outcome.kind === "committed");
    const projected = {
      ...message,
      __openclaw: { modelPromptProjection: { version: 1, text } },
    };
    const expectedEvents = [rewrite.header, { ...question, message: projected }, carrier];
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
  }),
);

it("commits a changed prompt with a duplicate carrier and leaves unchanged replay untouched", () =>
  withActor(async (f) => {
    const text = "Final transformed question";
    const { rewrite, carrier, command } = promptCarrier(f, text);
    assert("append" in command.input && command.input.append?.kind === "metadata");
    const append = command.input.append;
    const projection = append.modelPromptProjection;
    assert(projection);
    delete append.modelPromptProjection;
    await f.prepare(command);
    const first = f.mutate(command);
    assert(first.kind === "committed");
    append.modelPromptProjection = projection;
    append.input.options.expectedMutationAt = first.receipt.transcript.after.updatedAt;
    command.input.commandId = "changed-prompt-duplicate-carrier";
    await f.prepare(command);
    const changed = f.mutate(command);
    assert(changed.kind === "committed");
    expect(changed.receipt.transcript.after.updatedAt).toBeGreaterThan(
      first.receipt.transcript.after.updatedAt!,
    );
    expect(changed.receipt.transcript.after.generation).not.toBe(
      first.receipt.transcript.after.generation,
    );
    const expectedEvents = [
      rewrite.header,
      {
        ...question,
        message: { ...message, __openclaw: { modelPromptProjection: { version: 1, text } } },
      },
      carrier,
    ];
    append.input.options.expectedMutationAt = changed.receipt.transcript.after.updatedAt;
    command.input.commandId = "unchanged-prompt-duplicate-carrier";
    await f.prepare(command);
    const unchanged = f.mutate(command);
    assert(unchanged.kind === "committed");
    expect(unchanged.receipt.transcript.after).toEqual(changed.receipt.transcript.after);
    f.restartActor();
    await f.reopenDatabase();
    expect(f.read().transcript.version).toEqual(changed.receipt.transcript.after);
    expect(rewrite.rows().map((row) => JSON.parse(row.eventJson))).toEqual(expectedEvents);
  }));

it.each(["stale-preimage", "commit-refused"] as const)(
  "rolls back both prompt capture and its carrier when %s",
  (failure) =>
    withActor(async (f) => {
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
    }),
);
