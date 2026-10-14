import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionActorHotState } from "./session-actor-contract.js";
import { createSessionActorCommittedOutcome } from "./session-actor-receipt.js";
import { withActor, type Mutation } from "./session-actor-worker.test-support.js";

// mock-isolation: The fixture owns its database lifetime without background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture controls archival rather than launching disk-budget maintenance.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("publishes only newly committed events with exact stored UTF-8 sizes, including noncanonical JSON", async () => {
  await withActor(async (f) => {
    runSqliteImmediateTransactionSync(f.database.db, () => {
      appendTranscriptEventsInTransaction(f.database, f.scope, [
        {
          type: "session",
          id: f.scope.sessionId,
          version: 3,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/synthetic",
        },
      ]);
    });
    const event = {
      type: "model_change",
      id: "model-change",
      parentId: null,
      timestamp: "2026-01-01T00:00:01Z",
      provider: "synthetic",
      modelId: "fixture-🦞",
    };
    const eventJson = JSON.stringify(event, null, 2);
    const command: Mutation = {
      type: "session.actor.appendTranscriptEvent",
      input: {
        target: f.target,
        expected: f.read().version,
        commandId: "model-change",
        phaseId: "model",
        sessionId: f.scope.sessionId,
        lifecycleRevision: null,
        eventJson,
      },
    };
    await f.prepare(command);
    const first = f.mutate(command);
    if (first.kind !== "committed") {
      throw new Error("Expected transcript append commit");
    }
    expect(first.receipt.transcript.appendedEvents).toEqual([
      { rawSeq: 1, event, serializedBytes: Buffer.byteLength(eventJson) + 1 },
    ]);
    expect(readTranscriptEventRows(f.database, f.scope.sessionId).at(-1)?.eventJson).toBe(
      eventJson,
    );
    const retry = f.mutate({
      ...command,
      input: {
        ...command.input,
        expected: first.receipt.afterVersion,
        commandId: "model-change-retry",
      },
    });
    expect(retry).toMatchObject({
      kind: "committed",
      receipt: { transcript: { appendedEvents: [] } },
    });
  });
});

function hot(rawSeq: number, generation = "generation"): SessionActorHotState {
  return {
    target: {
      sessionKey: "agent:main:receipt",
      database: { kind: "memory", handle: "receipt", incarnation: "receipt" },
    },
    version: { epoch: "epoch", sequence: rawSeq },
    writeToken: String(rawSeq),
    dependencySessionIds: ["session"],
    entry: { sessionId: "session", updatedAt: 1 },
    hasBoard: false,
    participants: [],
    members: [],
    pendingInputs: [],
    completionKeys: [],
    transcript: {
      version: { rawSeq, generation, updatedAt: 1 },
      watermark: { maxSeq: rawSeq, generation },
      anchorsState: "resident",
      anchors: [],
      idempotency: [],
      modelContext: { kind: "resident", entries: [] },
    },
  };
}

it("detaches complete append deltas and omits unavailable, incomplete, or replaced histories", () => {
  const payload = {
    event: { id: "entry", message: { content: "committed" } },
    serializedBytes: 51,
  };
  const payloads = new Map([[2, payload]]);
  const create = (after: SessionActorHotState, supplied = payloads) =>
    createSessionActorCommittedOutcome({
      phase: "patch",
      command: { commandId: "patch", phaseId: "accounting" },
      before: hot(1),
      after,
      payloads: supplied,
      applied: { value: undefined, reducers: [] },
    }).receipt.transcript.appendedEvents;
  const complete = create(hot(2));
  payload.event.message.content = "changed after receipt";
  expect(complete).toEqual([
    { rawSeq: 2, event: { id: "entry", message: { content: "committed" } }, serializedBytes: 51 },
  ]);
  expect(create(hot(1))).toEqual([]);
  expect(create(hot(2), new Map())).toBeUndefined();
  expect(create(hot(3))).toBeUndefined();
  expect(create(hot(2, "replacement"))).toBeUndefined();
  expect(create(hot(0))).toBeUndefined();
});

it("keeps append receipts independent of retained transcript length", async () => {
  await withActor(async (f) => {
    const history = Array.from({ length: 256 }, (_, index) => ({
      type: "message",
      id: `history-${index}`,
      parentId: index ? `history-${index - 1}` : null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "synthetic history", idempotencyKey: `input-${index}` },
    }));
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, history),
    );
    const event = {
      type: "custom",
      customType: "synthetic-receipt",
      id: "new-event",
      parentId: "history-255",
      timestamp: "2026-01-01T00:00:01Z",
      data: { content: "x".repeat(6 * 1024) },
    };
    const command: Mutation = {
      type: "session.actor.appendTranscriptEvent",
      input: {
        target: f.target,
        commandId: "bounded-receipt",
        phaseId: "turn",
        sessionId: f.scope.sessionId,
        lifecycleRevision: null,
        eventJson: JSON.stringify(event),
      },
    };
    await f.prepare(command);
    const outcome = f.mutate(command);
    if (outcome.kind !== "committed") {
      throw new Error("Expected append commit");
    }
    expect(serialize(outcome).byteLength).toBeLessThan(16 * 1024);
    expect(outcome.receipt.transcript.appendedEvents).toEqual([
      { rawSeq: 256, event, serializedBytes: Buffer.byteLength(JSON.stringify(event)) + 1 },
    ]);
    expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toHaveLength(257);
    const retry = f.mutate({ ...command, input: { ...command.input, commandId: "retry" } });
    expect(retry).toMatchObject({
      kind: "committed",
      receipt: { transcript: { appendedEvents: [] } },
    });
    expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toHaveLength(257);
  });
});
