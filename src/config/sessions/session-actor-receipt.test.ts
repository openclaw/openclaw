import assert from "node:assert/strict";
import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import type { SessionActorHotState } from "./session-actor-contract.js";
import {
  createSessionActorCommittedOutcome,
  projectSessionActorCommittedOutcome,
  restoreSessionActorCommittedOutcome,
} from "./session-actor-receipt.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import { addSessionMember } from "./session-sharing-store.native.js";
import { buildSessionTranscriptTurnExpectedState } from "./session-transcript-turn-state.js";

// mock-isolation: Count real receipt encodings separately from residency/transport work.
vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:v8")>();
  return { ...actual, serialize: vi.fn(actual.serialize) };
});

// mock-isolation: The fixture owns its database lifetime without background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture controls archival rather than launching disk-budget maintenance.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

async function append(f: Fixture, eventJson: string, expected?: SessionActorHotState["version"]) {
  const command: Mutation = {
    type: "session.actor.appendTranscriptEvent",
    input: {
      target: f.target,
      sessionId: f.scope.sessionId,
      lifecycleRevision: null,
      commandId: "append",
      phaseId: "turn",
      expected,
      eventJson,
    },
  };
  await f.prepare(command);
  vi.mocked(serialize).mockClear();
  const outcome = f.mutate(command);
  assert(outcome.kind === "committed", "Expected transcript append commit");
  return { command, outcome };
}

function expectRetry(f: Fixture, command: Mutation) {
  expect(f.mutate(command)).toMatchObject({
    kind: "committed",
    receipt: { transcript: { appendedEvents: [] } },
  });
}

it("detaches read and committed metadata while retaining the actor's current facts", () =>
  withActor(async (f) => {
    const participant = { identity: { type: "agent" as const, id: "peer" }, promptedAt: 10 };
    f.participant(participant);
    addSessionMember(f.scope, { identityId: "viewer", addedBy: "owner", addedAt: 1 });
    f.restartActor();
    let before: SessionActorHotState;
    {
      using decode = vi.spyOn(JSON, "parse");
      before = f.read();
      expect(
        decode.mock.calls.filter(
          ([json]) => json.includes('"actor_id"') && json.includes('"contribution_count"'),
        ),
      ).toHaveLength(1);
    }
    const command: Mutation = {
      type: "session.actor.patch",
      input: {
        target: f.target,
        expected: before.version,
        commandId: "metadata-isolation",
        phaseId: "turn",
        reducers: [{ kind: "activity", updatedAt: 20 }],
      },
    };
    await f.prepare(command);
    const outcome = f.mutate(command);
    assert(outcome.kind === "committed");
    const current = f.read();
    for (const snapshot of [before, outcome.receipt.postimage]) {
      Object.assign(snapshot.target, { sessionKey: "caller edit" });
      Object.assign(snapshot.version, { sequence: -1 });
      snapshot.participants[0]!.identity.id = "caller edit";
      snapshot.members[0]!.identityId = "caller edit";
    }
    expect(f.read()).toEqual(current);
    f.participant({ ...participant, promptedAt: 30 });
    expect(f.read().participants[0]).toMatchObject({ contributionCount: 2, lastPromptedAt: 30 });
    expect(current.participants[0]).toMatchObject({ contributionCount: 1, lastPromptedAt: 10 });
  }));

it("publishes only newly committed events with exact stored UTF-8 sizes, including noncanonical JSON", () =>
  withActor(async (f) => {
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
    const { command, outcome: first } = await append(f, eventJson, f.read().version);
    expect(first.receipt.transcript.appendedEvents).toEqual([
      { rawSeq: 1, event, serializedBytes: Buffer.byteLength(eventJson) + 1 },
    ]);
    expect(readTranscriptEventRows(f.database, f.scope.sessionId).at(-1)?.eventJson).toBe(
      eventJson,
    );
    expectRetry(f, {
      ...command,
      input: {
        ...command.input,
        expected: first.receipt.afterVersion,
        commandId: "model-change-retry",
      },
    });
  }));

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
  const receiptBytes: number[] = [];
  for (const historyLength of [16, 256]) {
    await withActor(async (f) => {
      const history = Array.from({ length: historyLength }, (_, index) => ({
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
        parentId: `history-${historyLength - 1}`,
        timestamp: "2026-01-01T00:00:01Z",
        data: { content: "x".repeat(6 * 1024) },
      };
      const { command, outcome } = await append(f, JSON.stringify(event));
      const fullReceiptEncodings = vi
        .mocked(serialize)
        .mock.calls.filter(
          ([value]) =>
            value?.kind === "committed" && value.receipt?.kind === "session-actor-committed",
        );
      expect(fullReceiptEncodings).toHaveLength(1);
      const bytes = serialize(outcome).byteLength;
      receiptBytes.push(bytes);
      expect(bytes).toBeLessThan(16 * 1024);
      expect(outcome.receipt.postimage).toMatchObject({
        completionKeys: [],
        transcript: {
          anchorsState: "unavailable",
          anchors: [],
          idempotency: [],
          modelContext: { kind: "unavailable" },
        },
      });
      expect(outcome.receipt.transcript.appendedEvents).toEqual([
        {
          rawSeq: historyLength,
          event,
          serializedBytes: Buffer.byteLength(JSON.stringify(event)) + 1,
        },
      ]);
      expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toHaveLength(
        historyLength + 1,
      );
      expectRetry(f, { ...command, input: { ...command.input, commandId: "retry" } });
      expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toHaveLength(
        historyLength + 1,
      );
    });
  }
  // Scalar sequence/count encodings may grow; retained history must not cross the worker boundary.
  expect(Math.max(...receiptBytes) - Math.min(...receiptBytes)).toBeLessThan(128);
});

it.each([16, 512])("encodes a required full reload once with %s resident events", async (count) => {
  await withActor(async (f) => {
    const history = Array.from({ length: count }, (_, index) => ({
      type: "custom",
      customType: "synthetic",
      id: `history-${index}`,
      parentId: index ? `history-${index - 1}` : null,
      timestamp: "2026-01-01T00:00:00Z",
      data: { text: "x".repeat(1024) },
    }));
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, history),
    );
    const before = f.read();
    const event = { ...history[0]!, id: "appended", parentId: `history-${count - 1}` };
    vi.mocked(serialize).mockClear();
    const outcome = f.mutate({
      type: "session.actor.appendTranscriptEvent",
      input: {
        target: f.target,
        commandId: "reload",
        phaseId: "turn",
        entryReference: before.writeToken,
        append: {
          kind: "metadata",
          input: {
            scope: f.scope,
            event: JSON.stringify(event),
            options: {},
            view: { loadedVersion: { generation: null, rawSeq: null, updatedAt: null } },
          },
        },
      },
    });
    assert(outcome.kind === "committed");
    const appended = outcome.receipt.transcript.append;
    assert(appended?.kind === "metadata");
    expect(appended.value.reload).toMatchObject({
      ok: true,
      value: {
        kind: "full",
        snapshot: { events: [...history, event] },
      },
    });
    const reloadEncodings = vi
      .mocked(serialize)
      .mock.calls.filter(
        ([value]) =>
          value === appended.value ||
          value?.reload?.ok ||
          value?.receipt?.transcript?.append?.value?.reload?.ok,
      );
    expect(reloadEncodings).toHaveLength(1);
    expect(
      readTranscriptEventRows(f.database, f.scope.sessionId).map((row) => row.eventJson),
    ).toEqual([...history, event].map((row) => JSON.stringify(row)));
  });
});

it("commits an append when deep historical JSON cannot cross the reload transport", async () => {
  await withActor(async (f) => {
    const deepJson =
      '{"type":"custom","customType":"deep","id":"deep","parentId":null,"timestamp":"2026-01-01T00:00:00Z","data":' +
      "[".repeat(50_000) +
      "0" +
      "]".repeat(50_000) +
      "}";
    expect(() => serialize(JSON.parse(deepJson))).toThrow(RangeError);
    const history = Array.from({ length: 513 }, (_, index) => ({
      type: "custom",
      customType: "synthetic",
      id: `tail-${index}`,
      parentId: index ? `tail-${index - 1}` : "deep",
      timestamp: "2026-01-01T00:00:00Z",
    }));
    runSqliteImmediateTransactionSync(f.database.db, () => {
      appendTranscriptEventInTransaction(f.database, f.scope, JSON.parse(deepJson), {
        eventJson: deepJson,
        scheduleProjectionReconcile: false,
      });
      appendTranscriptEventsInTransaction(f.database, f.scope, history, {
        scheduleProjectionReconcile: false,
      });
    });
    const before = f.read();
    const event = { ...history[0]!, id: "appended", parentId: "tail-512" };
    const outcome = f.mutate({
      type: "session.actor.appendTranscriptEvent",
      input: {
        target: f.target,
        commandId: "deep-reload",
        phaseId: "turn",
        entryReference: before.writeToken,
        append: {
          kind: "metadata",
          input: {
            scope: f.scope,
            event: JSON.stringify(event),
            options: {},
            view: { loadedVersion: { generation: null, rawSeq: null, updatedAt: null } },
          },
        },
      },
    });
    assert(outcome.kind === "committed");
    const appended = outcome.receipt.transcript.append;
    assert(appended?.kind === "metadata");
    expect(appended.value.reload).toMatchObject({
      ok: false,
      error: {
        nodes: [expect.objectContaining({ name: "RangeError" })],
      },
    });
    const stored = readTranscriptEventRows(f.database, f.scope.sessionId);
    expect(stored).toHaveLength(515);
    expect(stored[0]?.eventJson).toBe(deepJson);
    expect(stored.at(-1)?.eventJson).toBe(JSON.stringify(event));
    expect(f.read().transcript.version.rawSeq).toBe(514);
  });
});

it.each([false, true])("restores only an exact preimage (delta=%s)", (changed) => {
  const before = hot(1);
  before.entry = { sessionId: "session", updatedAt: 1, label: "removed", inputTokens: 3 };
  const entry = changed
    ? { sessionId: "session", updatedAt: 2, inputTokens: 3, outputTokens: 4 }
    : before.entry;
  const outcome = createSessionActorCommittedOutcome({
    phase: changed ? "patch" : "appendTranscriptEvent",
    command: { commandId: "append", phaseId: "turn" },
    before,
    after: { ...hot(2), entry },
    applied: { value: { projectionNeedsReconcile: false }, reducers: [] },
  });
  const wire = projectSessionActorCommittedOutcome(outcome, before);
  expect(wire.receipt.postimage.entry).toBeUndefined();
  for (const reference of [undefined, { ...before, writeToken: "another-revision" }]) {
    expect(() => restoreSessionActorCommittedOutcome(wire, reference)).toThrow(
      "Session actor receipt entry reference is unavailable",
    );
    expect(wire.receipt.postimage.entry).toBeUndefined();
  }
  expect(restoreSessionActorCommittedOutcome(wire, before).receipt.postimage.entry).toEqual(entry);
  expect(before.entry).toMatchObject({ label: "removed", updatedAt: 1 });
});

it.each(["append", "tool", "patch", "adopt"] as const)(
  "bounds receipts against the exact preimage held by a %s command",
  (phase) =>
    withActor(async (f) => {
      const prompt = "synthetic instructions ".repeat(1600);
      f.writeEntry({ ...f.nativeEntry()!, skillsSnapshot: { prompt, skills: [] } });
      for (const mode of ["matching", "stale", "changed"] as const) {
        const before = f.read();
        const updatedAt = mode === "changed" ? 20 : before.entry!.updatedAt;
        const input = {
          target: f.target,
          sessionId: f.scope.sessionId,
          expectedState: buildSessionTranscriptTurnExpectedState(before.entry!),
          lifecycle: {},
          commandId: `resident-${phase}-${mode}`,
          phaseId: "turn",
          entryReference: mode === "stale" ? "stale-token" : before.writeToken,
          reducers: [{ kind: "activity" as const, updatedAt }],
        };
        const selected: Mutation =
          phase === "patch" || phase === "adopt"
            ? { type: phase === "patch" ? "session.actor.patch" : "session.actor.adoptRun", input }
            : phase === "tool"
              ? {
                  type: "session.actor.appendToolResult",
                  input: {
                    ...input,
                    append: {
                      kind: "message",
                      input: {
                        scope: f.scope,
                        cwd: "/synthetic",
                        messageJson: JSON.stringify({
                          role: "toolResult",
                          toolCallId: `tool-${mode}`,
                          toolName: "synthetic",
                          content: [{ type: "text", text: "x".repeat(1024) }],
                          isError: false,
                          timestamp: 1,
                        }),
                      },
                    },
                  },
                }
              : {
                  type: "session.actor.appendTranscriptEvent",
                  input: {
                    ...input,
                    lifecycleRevision: null,
                    eventJson: JSON.stringify({
                      type: "custom",
                      customType: "synthetic-receipt",
                      id: `new-event-${mode}`,
                      parentId: null,
                      data: { content: "x".repeat(6 * 1024) },
                    }),
                  },
                };
        await f.prepare(selected);
        const outcome = f.mutate(selected);
        assert(outcome.kind === "committed");
        if (mode !== "stale") {
          expect(serialize(outcome).byteLength).toBeLessThan(16 * 1024);
          const restored = restoreSessionActorCommittedOutcome(outcome, before);

          expect(restored.receipt.postimage).toEqual(f.read());
          expect(restored.receipt.postimage.entry?.skillsSnapshot).toBe(
            before.entry?.skillsSnapshot,
          );
        } else {
          expect(outcome.receipt.postimage).toEqual(f.read());
          outcome.receipt.postimage.entry!.skillsSnapshot!.prompt = "caller edit";
        }
        expect(before.entry?.skillsSnapshot?.prompt).toBe(prompt);
        expect(f.read().entry?.skillsSnapshot?.prompt).toBe(prompt);
        expect(f.nativeEntry()?.skillsSnapshot?.prompt).toBe(prompt);
        expect(f.nativeEntry()?.updatedAt).toBe(updatedAt);
      }
    }),
);
