import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionActorAppend,
  SessionActorOutcome,
  SessionActorReceipt,
} from "./session-actor-contract.js";
import { authority, memoryOwnerFixture } from "./session-actor-memory-family.test-support.js";
import type { SessionPendingInputWorkerFacts } from "./session-pending-input.types.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import type { SessionTurnPlan } from "./session-turn.types.js";
import type { InternalSessionEntry } from "./types.js";

const sessionKey = "agent:main:dashboard:incognito-transcript-test";
const sessionId = "session-1";
const path = ":memory:transcript-test";
const scope = { agentId: "main", storePath: path, sessionKey, sessionId };
const openFixture = memoryOwnerFixture({ agentId: "main", path });

function committed<Value>(outcome: SessionActorOutcome<Value>) {
  assert(outcome.kind === "committed", "Expected a committed command");
  return outcome;
}

type MetadataInput = Extract<SessionActorAppend, { kind: "metadata" }>["input"];
type TurnMessages = SessionTurnPlan["options"]["messages"];
function messageInput(
  id: string,
  parentId: string,
  messageJson: string,
  validateTurn = false,
  time = 2,
) {
  return {
    event: { type: "message" as const, id, parentId, timestamp: new Date(time).toISOString() },
    message: { messageJson, cwd: "/synthetic", validateTurn },
  };
}

function metadataResult(outcome: SessionActorOutcome<unknown>) {
  const result = committed(outcome).receipt.transcript.append;
  assert(result?.kind === "metadata");
  return result.value;
}

function expectMessage(
  receipt: SessionActorReceipt,
  appended: boolean,
  messageId: string,
  message: unknown,
) {
  expect(receipt.transcript.appendedMessages).toMatchObject([{ appended, messageId, message }]);
}

function expectPending(
  receipt: SessionActorReceipt,
  transcriptInputId: string,
  consumedInputIds: string[],
) {
  expect(receipt.pendingInputReceipt).toEqual({ transcriptInputId, consumedInputIds });
}

function pendingFacts(
  message: { idempotencyKey: string },
  inputId: string,
  transcriptInputId = inputId,
): SessionPendingInputWorkerFacts {
  return {
    agentId: "main",
    databaseAgentId: "main",
    databasePath: path,
    sessionKey,
    sessionId,
    inputId,
    transcriptInputId,
    idempotencyKey: message.idempotencyKey,
    lifecycleGeneration: "life-1",
    messageJson: JSON.stringify(message),
  };
}

function turn(
  messages: TurnMessages[number][] | TurnMessages[number],
  options: Partial<SessionTurnPlan["options"]> = {},
): SessionTurnPlan {
  return {
    agentId: "main",
    sessionKey,
    options: {
      expectedSessionId: sessionId,
      sessionFile: "/synthetic/transcript",
      messages: Array.isArray(messages) ? messages : [messages],
      ...options,
    },
  };
}

async function fixture(
  initialEntry: Partial<InternalSessionEntry> = {},
  cliWriter?: SessionTurnPlan["cliWriter"],
) {
  const { actor } = await openFixture(sessionKey);
  committed(
    await actor.acceptInput(
      {
        commandId: "initialize",
        phaseId: "turn",
        expectedState: buildRestartRecoveryExpectedState({ sessionId: "session-1", updatedAt: 1 }),
        lifecycle: {},
        turn: {
          ...turn(
            {
              message: { role: "user", content: "Hello", timestamp: 1 },
              eventId: "user-1",
              now: 1,
            },
            {
              initialSessionEntry: { sessionId, incognito: true, updatedAt: 1, ...initialEntry },
            },
          ),
          cliWriter,
        },
      },
      authority,
    ),
  );
  let command = 0;
  const append = (plan: SessionTurnPlan) =>
    actor.appendToolResult(
      { commandId: `append-${++command}`, phaseId: "turn", turn: plan },
      authority,
    );
  return {
    actor,
    append,
    write: async (...args: Parameters<typeof turn>) => committed(await append(turn(...args))),
    metadata: (
      commandId: string,
      input: Omit<MetadataInput, "scope" | "options"> &
        Partial<Pick<MetadataInput, "scope" | "options">>,
    ) =>
      actor.appendTranscriptEvent(
        {
          commandId,
          phaseId: "turn",
          append: { kind: "metadata", input: { scope, options: {}, ...input } },
        },
        authority,
      ),
    stage: (commandId: string, source: SessionPendingInputWorkerFacts) =>
      actor.acceptInput(
        {
          commandId,
          phaseId: "turn",
          expectedState: buildRestartRecoveryExpectedState({ sessionId, updatedAt: 1 }),
          lifecycle: {},
          pending: {
            kind: "stage",
            sessionKey,
            sessionId,
            idempotencyKey: source.idempotencyKey,
            inputId: source.inputId,
            runId: "run-1",
            requestHash: "request-1",
            lifecycleGeneration: source.lifecycleGeneration,
            messageJson: source.messageJson,
            trackCompletion: true,
            expected: {
              kind: "stage",
              current: true,
              existing: undefined,
              previous: undefined,
              committed: undefined,
            },
          },
        },
        authority,
      ),
  };
}

describe("memory actor transcript", () => {
  it("preserves prepared storage bytes and returns canonical identity on metadata replay", async () => {
    const { metadata } = await fixture();
    const messageJson =
      '{ "role": "assistant", "content": "Exact bytes", "timestamp": 2, "idempotencyKey": "answer" }';
    const input = {
      ...messageInput("assistant-1", "user-1", messageJson),
      view: { loadedVersion: { generation: null, rawSeq: null, updatedAt: null } },
    };
    using parse = vi.spyOn(JSON, "parse");
    const first = committed(await metadata("metadata", input));
    // Decode once for admission and once for the detached result; reload uses the envelope.
    expect(parse.mock.calls.filter(([json]) => json === messageJson).length).toBeLessThanOrEqual(2);
    const result = metadataResult(first);
    assert(result.reload?.ok && result.reload.value.kind === "full");
    expect(result.reload.value.snapshot.eventJson?.at(-1)).toContain(`"message":${messageJson}}`);
    const replay = committed(
      await metadata("replay", { ...input, event: { ...input.event, id: "retry-id" } }),
    );
    expectMessage(replay.receipt, false, "assistant-1", { content: "Exact bytes" });
    expect(replay.receipt.transcript.after).toEqual(first.receipt.transcript.after);
  });

  it("commits initial metadata after a sibling write and rolls back an incomplete pair", async () => {
    const { actor, metadata, write } = await fixture();
    const beforeSibling = actor.snapshot(authority)!.transcript.version;
    await write({ message: { role: "assistant", content: "Sibling" }, eventId: "sibling" });
    const beforePair = actor.snapshot(authority)!.transcript.version;
    const initialModel = {
      type: "model_change" as const,
      id: "model",
      parentId: "user-1",
      timestamp: "1970-01-01T00:00:00.003Z",
      provider: "synthetic",
      modelId: "synthetic-model",
    };
    const thinking = {
      type: "thinking_level_change" as const,
      id: "thinking",
      parentId: initialModel.id,
      timestamp: initialModel.timestamp,
      thinkingLevel: "high",
    };
    const outcome = committed(
      await metadata("initial-metadata", {
        initialModel,
        event: JSON.stringify(thinking),
        options: { appendIntent: "active-branch", expectedMutationAt: beforePair.updatedAt },
        view: { loadedVersion: beforeSibling },
      }),
    );
    const appended = metadataResult(outcome);
    assert(appended.reload?.ok && appended.reload.value.kind === "full");
    expect(appended.snapshot).toMatchObject({ ok: true, value: { before: beforePair } });
    expect(appended.initialModelParentId).toBe("sibling");
    expect(appended.reload.value.snapshot.events.slice(-3)).toMatchObject([
      { id: "sibling" },
      { id: "model", parentId: "sibling" },
      { id: "thinking", parentId: "model", thinkingLevel: "high" },
    ]);

    const beforeRefusal = actor.snapshot(authority);
    expect(
      await metadata("incomplete-pair", {
        initialModel: { ...initialModel, id: "rolled-back-model", parentId: "thinking" },
        event: JSON.stringify({ ...thinking, parentId: "rolled-back-model" }),
      }),
    ).toMatchObject({ kind: "rolled-back" });
    expect(actor.snapshot(authority)).toEqual(beforeRefusal);
  });

  it("resolves prepared retries before replacement and skips a fresh suppressed message", async () => {
    const { actor, write } = await fixture();
    const original = { role: "assistant", content: "Original", idempotencyKey: "prepared" };
    const accepted = { ...original, content: "Prepared" };
    const before = actor.snapshot(authority)!.transcript.version;
    await write({
      message: original,
      eventId: "prepared-1",
      preparationVersion: before,
      preparedMessage: { prepared: true, message: accepted },
    });
    const replay = await write({
      message: original,
      preparationVersion: before,
      preparedMessage: {
        prepared: true,
        message: { ...original, content: "Must not replace the accepted message" },
      },
    });
    expectMessage(replay.receipt, false, "prepared-1", accepted);
    const skipped = await write({
      message: { ...original, idempotencyKey: "suppressed" },
      preparationVersion: before,
      preparedMessage: { prepared: true, message: undefined },
      expectedTranscript: before,
    });
    expect(skipped.receipt.transcript.appendedMessages).toEqual([]);
    expect(skipped.receipt.transcript.after).toEqual(replay.receipt.transcript.after);
  });

  it("promotes accepted pending bytes, consumes custody once, and rejects a mismatched owner", async () => {
    const { actor, append, stage, metadata } = await fixture();
    const message = {
      role: "user",
      content: "Accepted input",
      timestamp: 2,
      idempotencyKey: "pending",
    };
    const custody = pendingFacts(message, "input-2");
    committed(await stage("stage", custody));
    const plan = {
      ...turn({
        message: { ...message, content: "New host candidate" },
        preparedMessage: {
          prepared: false,
          message: { ...message, content: "New prepared candidate" },
        },
      }),
      custody,
    };
    const snapshot = actor.snapshot(authority);
    expect(
      await append({ ...plan, custody: { ...custody, lifecycleGeneration: "wrong" } }),
    ).toMatchObject({ kind: "rolled-back" });
    expect(actor.snapshot(authority)).toEqual(snapshot);
    const promoted = committed(
      await metadata("promote", {
        ...messageInput("host-candidate", "user-1", custody.messageJson),
        message: {
          messageJson: JSON.stringify({ ...message, content: "New host candidate" }),
          cwd: "/synthetic",
          validateTurn: false,
          pendingInput: { facts: custody },
        },
      }),
    );
    expectMessage(promoted.receipt, true, "input-2", message);
    expectPending(promoted.receipt, "input-2", ["input-2"]);
    expect(actor.snapshot(authority)?.pendingInputs).toEqual([]);
    const replay = committed(await append(plan));
    expectMessage(replay.receipt, false, "input-2", message);
    expectPending(replay.receipt, "input-2", []);
    const relocation = {
      ...turn({ message, eventId: "relocated", idempotencyLookup: "caller-checked" }),
      custody,
      relocation: "input-2",
    };
    const relocated = committed(await append(relocation));
    expectMessage(relocated.receipt, true, "relocated", message);
    expectPending(relocated.receipt, "relocated", []);
    expect(actor.snapshot(authority)?.transcript.idempotency).toContainEqual(
      expect.objectContaining({ key: "pending", eventId: "relocated" }),
    );
    const retried = committed(await append(relocation));
    expectMessage(retried.receipt, false, "relocated", message);
    expectPending(retried.receipt, "relocated", []);
  });

  it("replays collected promotion when its transcript identity differs from source input identity", async () => {
    const { append, stage } = await fixture();
    const message = {
      role: "user",
      content: "Collected input",
      timestamp: 2,
      idempotencyKey: "collected",
    };
    const source = pendingFacts(message, "source-input", "collected-transcript");
    committed(await stage("stage-collected", source));
    const plan = { ...turn({ message }), custody: { ...source, sources: [source] } };
    const first = committed(await append(plan));
    expectPending(first.receipt, "collected-transcript", ["source-input"]);
    const replay = committed(await append(plan));
    expectMessage(replay.receipt, false, "collected-transcript", message);
    expectPending(replay.receipt, "collected-transcript", []);
    expect(replay.receipt.transcript.after).toEqual(first.receipt.transcript.after);
  });

  it("rebases active appends, preserves explicit branches, and rolls back a mixed atomic batch", async () => {
    const { actor, append, write } = await fixture();
    const firstMessage = { role: "assistant", content: "First", idempotencyKey: "first" };
    await write({ message: firstMessage, eventId: "first", parentId: "user-1" });
    const rebased = await write({
      message: { role: "assistant", content: "Rebased" },
      eventId: "rebased",
      parentId: "user-1",
      appendIntent: "active-branch",
    });
    expect(rebased.receipt.transcript.appendedMessages[0]?.effectiveParentId).toBe("first");
    expect(rebased.value).toMatchObject({ sequences: [3] });
    const branched = await write({
      message: { role: "assistant", content: "Branch", idempotencyKey: "branch" },
      eventId: "branch",
      parentId: "user-1",
    });
    expect(branched.value).toMatchObject({ sequences: [2] });
    expect(actor.snapshot(authority)?.transcript.anchors.map((entry) => entry.entryId)).toEqual([
      "user-1",
      "branch",
    ]);
    const facts = await actor.storage!.read(
      {
        type: "session.transcript.messageFacts",
        input: {
          scope: { agentId: "main", storePath: path, sessionKey, sessionId },
          idempotencyKeys: ["first", "branch"],
          activeBranchOnly: true,
        },
      },
      authority,
    );
    expect([...facts.facts.existingIdempotencyKeys]).toEqual(["branch"]);
    const before = actor.snapshot(authority);
    expect(
      await append(
        turn(
          [
            { message: firstMessage },
            { message: { role: "assistant", content: "Must roll back" }, eventId: "rollback" },
          ],
          { atomicGroup: true },
        ),
      ),
    ).toMatchObject({ kind: "rolled-back" });
    expect(actor.snapshot(authority)).toEqual(before);
  });

  it("advances CLI account coverage only across its own contiguous writes", async () => {
    const writer = {
      runId: "cli-run",
      authFingerprint: "a".repeat(64),
      lifecycleRevision: "cli-life",
    };
    const { actor, append } = await fixture(
      {
        activeWriterRunId: writer.runId,
        lifecycleRevision: writer.lifecycleRevision,
        cliHistoryBoundary: {
          version: 1,
          state: "known",
          sessionId,
          writerRunId: writer.runId,
          authFingerprint: writer.authFingerprint,
          generation: null,
          maxSeq: null,
        },
      },
      writer,
    );
    expect(actor.snapshot(authority)?.entry?.cliHistoryBoundary).toMatchObject({ maxSeq: 1 });
    const message = { role: "assistant", content: "CLI output" };
    committed(await append({ ...turn({ message, eventId: "cli-2" }), cliWriter: writer }));
    expect(actor.snapshot(authority)?.entry?.cliHistoryBoundary).toMatchObject({ maxSeq: 2 });
    committed(
      await append({
        ...turn({ message, eventId: "other-account" }),
        cliWriter: { ...writer, authFingerprint: "b".repeat(64) },
      }),
    );
    committed(await append({ ...turn({ message, eventId: "after-gap" }), cliWriter: writer }));
    expect(actor.snapshot(authority)?.entry?.cliHistoryBoundary).toMatchObject({ maxSeq: 2 });
    expect(actor.snapshot(authority)?.transcript.anchors.at(-1)?.entryId).toBe("after-gap");
  });

  it("commits a Goal with its admission turn and replays the receipt without another user message", async () => {
    const { actor, append } = await fixture();
    const plan = turn(
      {
        message: { role: "user", content: "Work on this Goal", idempotencyKey: "goal-input" },
        eventId: "goal-input",
      },
      {
        preparedGoalId: "goal-1",
        sessionTurnMutation: {
          kind: "goal",
          runId: "goal-run",
          operation: {
            action: "start",
            objective: "Finish the task",
            operationId: "goal-operation",
            issuedAtMs: Date.now(),
            requestFingerprint: "request",
          },
        },
      },
    );
    const first = committed(await append(plan));
    const goalResult = (replayed: boolean) => ({
      result: {
        sessionTurnMutationResult: { replayed, result: { goalId: "goal-1", runId: "goal-run" } },
      },
    });
    expect(first.value).toMatchObject(goalResult(false));
    expect(first.receipt.transcript.appendedMessages[0]?.message).toMatchObject({
      __openclaw: {
        intent: { kind: "session-goal-start", goalId: "goal-1", operationId: "goal-operation" },
      },
    });
    const snapshot = actor.snapshot(authority)!;
    const replay = committed(await append(plan));
    expect(replay.value).toMatchObject(goalResult(true));
    expect(replay.receipt.transcript.appendedMessages).toEqual([]);
    expect(actor.snapshot(authority)?.entry).toEqual(snapshot.entry);
    expect(replay.receipt.transcript.after).toEqual(snapshot.transcript.version);
    const identity = actor.target.database;
    assert(identity.kind === "memory");
    expect(
      await append({
        ...plan,
        ownerSources: [
          {
            source: { agentId: "main", path, databaseIdentity: identity.incarnation },
            sessionKey,
            fields: ["sessionId"],
            expected: { sessionId: "retired-session" },
          },
        ],
      }),
    ).toMatchObject({ kind: "rolled-back" });
  });

  it("reloads a bounded admitted view with hidden ancestry and the retained reset boundary", async () => {
    const { actor, metadata, write } = await fixture();
    committed(
      await actor.appendTranscriptEvent(
        {
          commandId: "reset",
          phaseId: "turn",
          sessionId,
          lifecycleRevision: null,
          eventJson: JSON.stringify({
            type: "reset",
            id: "reset",
            parentId: "user-1",
            timestamp: "1970-01-01T00:00:00.002Z",
            reason: "new",
            firstKeptEntryId: "user-1",
          }),
        },
        authority,
      ),
    );
    const latest = await write([
      { message: { role: "user", content: "Second user", timestamp: 3 }, eventId: "user-2" },
      {
        message: {
          role: "custom",
          customType: "display",
          content: "x".repeat(20_000),
          display: true,
          excludeFromContext: true,
        },
        eventId: "display",
      },
    ]);
    const user = latest.receipt.transcript.appendedMessages[0]?.anchor;
    assert(user, "Expected admitted user anchor");
    const result = committed(
      await metadata("bounded", {
        ...messageInput(
          "final",
          "display",
          JSON.stringify({ role: "assistant", content: "Answer" }),
          true,
          4,
        ),
        view: {
          loadedVersion: { generation: null, rawSeq: null, updatedAt: null },
          limits: { maxBytes: 4096, maxEvents: 2 },
          admission: { ...user, role: "user", logicalTurnId: "turn-2" },
        },
      }),
    );
    const appended = metadataResult(result);
    assert(appended.reload?.ok && appended.reload.value.kind === "bounded");
    const context = appended.reload.value.snapshot;
    expect(context.events).toMatchObject([
      { type: "session" },
      { id: "reset" },
      { id: "user-2" },
      { id: "final" },
    ]);
    expect(context.serializedBytes).toBeLessThan(4096);
    expect(context.parents.get("final")).toBe("display");
    expect(context.opaqueParents.get("display")).toBe("user-2");
    expect(context.firstKeptRanges.get("reset")).toEqual({ startIndex: 1, endIndex: 1 });
    expect(context).toMatchObject({
      boundaryCount: 1,
      activeLeafEntryId: "final",
      truncated: true,
    });
  });
});
