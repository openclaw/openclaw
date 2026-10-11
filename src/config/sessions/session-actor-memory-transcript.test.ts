import { afterEach, describe, expect, it } from "vitest";
import type { SessionActorAuthority, SessionActorOutcome } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { SessionPendingInputWorkerFacts } from "./session-pending-input.types.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import type { SessionTurnPlan } from "./session-turn.types.js";
import type { InternalSessionEntry } from "./types.js";

const sessionKey = "agent:main:dashboard:incognito-transcript-test";
const sessionId = "session-1";
const path = ":memory:transcript-test";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

function committed<Value>(outcome: SessionActorOutcome<Value>) {
  if (outcome.kind !== "committed") {
    throw new Error(`Expected a committed command: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function turn(
  messages: SessionTurnPlan["options"]["messages"],
  options: Partial<SessionTurnPlan["options"]> = {},
): SessionTurnPlan {
  return {
    agentId: "main",
    sessionKey,
    options: {
      expectedSessionId: sessionId,
      sessionFile: "/synthetic/transcript",
      messages,
      ...options,
    },
  };
}

async function fixture(
  initialEntry: Partial<InternalSessionEntry> = {},
  cliWriter?: SessionTurnPlan["cliWriter"],
) {
  const owner = createMemorySessionActorOwner({ agentId: "main", path });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  committed(
    await actor.acceptInput(
      {
        commandId: "initialize",
        phaseId: "turn",
        expectedState: buildRestartRecoveryExpectedState({ sessionId: "session-1", updatedAt: 1 }),
        lifecycle: {},
        turn: {
          ...turn(
            [
              {
                message: { role: "user", content: "Hello", timestamp: 1 },
                eventId: "user-1",
                now: 1,
              },
            ],
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
  return {
    actor,
    append: (plan: SessionTurnPlan) =>
      actor.appendToolResult(
        {
          commandId: `append-${++command}`,
          phaseId: "turn",
          turn: plan,
        },
        authority,
      ),
  };
}

describe("memory actor transcript", () => {
  it("preserves prepared storage bytes and returns canonical identity on metadata replay", async () => {
    const { actor } = await fixture();
    const messageJson =
      '{ "role": "assistant", "content": "Exact bytes", "timestamp": 2, "idempotencyKey": "answer" }';
    const input = {
      scope: { agentId: "main", storePath: path, sessionKey, sessionId },
      event: {
        type: "message" as const,
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "1970-01-01T00:00:00.002Z",
      },
      message: { messageJson, cwd: "/synthetic", validateTurn: false },
      options: {},
      view: { loadedVersion: { generation: null, rawSeq: null, updatedAt: null } },
    };
    const first = committed(
      await actor.appendTranscriptEvent(
        {
          commandId: "metadata",
          phaseId: "turn",
          append: { kind: "metadata", input },
        },
        authority,
      ),
    );
    const result = first.receipt.transcript.append;
    if (
      result?.kind !== "metadata" ||
      !result.value.reload?.ok ||
      result.value.reload.value.kind !== "full"
    ) {
      throw new Error("Expected full metadata reload");
    }
    expect(result.value.reload.value.snapshot.eventJson?.at(-1)).toContain(
      `"message":${messageJson}}`,
    );
    const replay = committed(
      await actor.appendTranscriptEvent(
        {
          commandId: "replay",
          phaseId: "turn",
          append: {
            kind: "metadata",
            input: { ...input, event: { ...input.event, id: "retry-id" } },
          },
        },
        authority,
      ),
    );
    expect(replay.receipt.transcript.appendedMessages).toMatchObject([
      {
        appended: false,
        messageId: "assistant-1",
        message: { content: "Exact bytes" },
      },
    ]);
    expect(replay.receipt.transcript.after).toEqual(first.receipt.transcript.after);
  });

  it("resolves prepared retries before replacement and skips a fresh suppressed message", async () => {
    const { actor, append } = await fixture();
    const original = { role: "assistant", content: "Original", idempotencyKey: "prepared" };
    const accepted = { ...original, content: "Prepared" };
    const before = actor.snapshot(authority)!.transcript.version;
    committed(
      await append(
        turn([
          {
            message: original,
            eventId: "prepared-1",
            preparationVersion: before,
            preparedMessage: { prepared: true, expected: undefined, message: accepted },
          },
        ]),
      ),
    );
    const replay = committed(
      await append(
        turn([
          {
            message: original,
            preparationVersion: before,
            preparedMessage: {
              prepared: true,
              expected: { messageId: "prepared-1", message: accepted },
              message: { ...original, content: "Must not replace the accepted message" },
            },
          },
        ]),
      ),
    );
    expect(replay.receipt.transcript.appendedMessages).toMatchObject([
      {
        appended: false,
        messageId: "prepared-1",
        message: accepted,
      },
    ]);
    const skipped = committed(
      await append(
        turn([
          {
            message: { ...original, idempotencyKey: "suppressed" },
            preparationVersion: before,
            preparedMessage: { prepared: true, expected: undefined, message: undefined },
            expectedTranscript: before,
          },
        ]),
      ),
    );
    expect(skipped.receipt.transcript.appendedMessages).toEqual([]);
    expect(skipped.receipt.transcript.after).toEqual(replay.receipt.transcript.after);
    const snapshot = actor.snapshot(authority);
    const stale = await append(
      turn([
        {
          message: original,
          preparedMessage: { prepared: true, expected: undefined, message: accepted },
        },
      ]),
    );
    expect(stale).toMatchObject({
      kind: "rolled-back",
      error: { message: "Transcript idempotency changed while preparing the turn" },
    });
    expect(actor.snapshot(authority)).toEqual(snapshot);
  });

  it("promotes accepted pending bytes, consumes custody once, and rejects a mismatched owner", async () => {
    const { actor, append } = await fixture();
    const message = {
      role: "user",
      content: "Accepted input",
      timestamp: 2,
      idempotencyKey: "pending",
    };
    const messageJson = JSON.stringify(message);
    committed(
      await actor.acceptInput(
        {
          commandId: "stage",
          phaseId: "turn",
          expectedState: buildRestartRecoveryExpectedState({
            sessionId: "session-1",
            updatedAt: 1,
          }),
          lifecycle: {},
          pending: {
            kind: "stage",
            sessionKey,
            sessionId,
            idempotencyKey: "pending",
            inputId: "input-2",
            runId: "run-1",
            requestHash: "request-1",
            lifecycleGeneration: "life-1",
            messageJson,
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
    );
    const custody: SessionPendingInputWorkerFacts = {
      agentId: "main",
      databaseAgentId: "main",
      databasePath: path,
      sessionKey,
      sessionId,
      inputId: "input-2",
      transcriptInputId: "input-2",
      idempotencyKey: "pending",
      lifecycleGeneration: "life-1",
      messageJson,
    };
    const plan = {
      ...turn([
        {
          message: { ...message, content: "New host candidate" },
          preparedMessage: {
            prepared: false,
            expected: undefined,
            message: { ...message, content: "New prepared candidate" },
          },
        },
      ]),
      custody,
    };
    const snapshot = actor.snapshot(authority);
    expect(
      await append({ ...plan, custody: { ...custody, lifecycleGeneration: "wrong" } }),
    ).toMatchObject({ kind: "rolled-back" });
    expect(actor.snapshot(authority)).toEqual(snapshot);
    const promoted = committed(
      await actor.appendTranscriptEvent(
        {
          commandId: "promote",
          phaseId: "turn",
          append: {
            kind: "metadata",
            input: {
              scope: { agentId: "main", storePath: path, sessionKey, sessionId },
              event: {
                type: "message",
                id: "host-candidate",
                parentId: "user-1",
                timestamp: "1970-01-01T00:00:00.002Z",
              },
              message: {
                messageJson: JSON.stringify({ ...message, content: "New host candidate" }),
                cwd: "/synthetic",
                validateTurn: false,
                pendingInput: { facts: custody },
              },
              options: {},
            },
          },
        },
        authority,
      ),
    );
    expect(promoted.receipt.transcript.appendedMessages).toMatchObject([
      {
        appended: true,
        messageId: "input-2",
        message,
      },
    ]);
    expect(promoted.receipt.pendingInputReceipt).toEqual({
      transcriptInputId: "input-2",
      consumedInputIds: ["input-2"],
    });
    expect(actor.snapshot(authority)?.pendingInputs).toEqual([]);
    const replay = committed(await append(plan));
    expect(replay.receipt.transcript.appendedMessages).toMatchObject([
      {
        appended: false,
        messageId: "input-2",
        message,
      },
    ]);
    expect(replay.receipt.pendingInputReceipt).toEqual({
      transcriptInputId: "input-2",
      consumedInputIds: [],
    });
    const relocation = {
      ...turn([{ message, eventId: "relocated", idempotencyLookup: "caller-checked" }]),
      custody,
      relocation: "input-2",
    };
    const relocated = committed(await append(relocation));
    expect(relocated.receipt.transcript.appendedMessages).toMatchObject([
      {
        appended: true,
        messageId: "relocated",
        message,
      },
    ]);
    expect(relocated.receipt.pendingInputReceipt).toEqual({
      transcriptInputId: "relocated",
      consumedInputIds: [],
    });
    expect(actor.snapshot(authority)?.transcript.idempotency).toContainEqual(
      expect.objectContaining({ key: "pending", eventId: "relocated" }),
    );
    const retried = committed(await append(relocation));
    expect(retried.receipt.transcript.appendedMessages).toMatchObject([
      { appended: false, messageId: "relocated", message },
    ]);
    expect(retried.receipt.pendingInputReceipt).toEqual({
      transcriptInputId: "relocated",
      consumedInputIds: [],
    });
  });

  it("replays collected promotion when its transcript identity differs from source input identity", async () => {
    const { actor, append } = await fixture();
    const message = {
      role: "user",
      content: "Collected input",
      timestamp: 2,
      idempotencyKey: "collected",
    };
    const messageJson = JSON.stringify(message);
    const source: SessionPendingInputWorkerFacts = {
      agentId: "main",
      databaseAgentId: "main",
      databasePath: path,
      sessionKey,
      sessionId,
      inputId: "source-input",
      transcriptInputId: "collected-transcript",
      idempotencyKey: "collected",
      lifecycleGeneration: "life-1",
      messageJson,
    };
    committed(
      await actor.acceptInput(
        {
          commandId: "stage-collected",
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
            messageJson,
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
    );
    const plan = { ...turn([{ message }]), custody: { ...source, sources: [source] } };
    const first = committed(await append(plan));
    expect(first.receipt.pendingInputReceipt).toEqual({
      transcriptInputId: "collected-transcript",
      consumedInputIds: ["source-input"],
    });
    const replay = committed(await append(plan));
    expect(replay.receipt.transcript.appendedMessages).toMatchObject([
      { appended: false, messageId: "collected-transcript", message },
    ]);
    expect(replay.receipt.pendingInputReceipt).toEqual({
      transcriptInputId: "collected-transcript",
      consumedInputIds: [],
    });
    expect(replay.receipt.transcript.after).toEqual(first.receipt.transcript.after);
  });

  it("rebases active appends, preserves explicit branches, and rolls back a mixed atomic batch", async () => {
    const { actor, append } = await fixture();
    const firstMessage = { role: "assistant", content: "First", idempotencyKey: "first" };
    committed(
      await append(turn([{ message: firstMessage, eventId: "first", parentId: "user-1" }])),
    );
    const rebased = committed(
      await append(
        turn([
          {
            message: { role: "assistant", content: "Rebased" },
            eventId: "rebased",
            parentId: "user-1",
            appendIntent: "active-branch",
          },
        ]),
      ),
    );
    expect(rebased.receipt.transcript.appendedMessages[0]?.effectiveParentId).toBe("first");
    expect(rebased.value).toMatchObject({ sequences: [3] });
    const branched = committed(
      await append(
        turn([
          {
            message: { role: "assistant", content: "Branch" },
            eventId: "branch",
            parentId: "user-1",
          },
        ]),
      ),
    );
    expect(branched.value).toMatchObject({ sequences: [2] });
    expect(actor.snapshot(authority)?.transcript.anchors.map((entry) => entry.entryId)).toEqual([
      "user-1",
      "branch",
    ]);
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
    committed(await append({ ...turn([{ message, eventId: "cli-2" }]), cliWriter: writer }));
    expect(actor.snapshot(authority)?.entry?.cliHistoryBoundary).toMatchObject({ maxSeq: 2 });
    committed(
      await append({
        ...turn([{ message, eventId: "other-account" }]),
        cliWriter: { ...writer, authFingerprint: "b".repeat(64) },
      }),
    );
    committed(await append({ ...turn([{ message, eventId: "after-gap" }]), cliWriter: writer }));
    expect(actor.snapshot(authority)?.entry?.cliHistoryBoundary).toMatchObject({ maxSeq: 2 });
    expect(actor.snapshot(authority)?.transcript.anchors.at(-1)?.entryId).toBe("after-gap");
  });

  it("commits a Goal with its admission turn and replays the receipt without another user message", async () => {
    const { actor, append } = await fixture();
    const plan = turn(
      [
        {
          message: { role: "user", content: "Work on this Goal", idempotencyKey: "goal-input" },
          eventId: "goal-input",
        },
      ],
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
    expect(first.value).toMatchObject({
      result: {
        sessionTurnMutationResult: {
          replayed: false,
          result: { goalId: "goal-1", runId: "goal-run" },
        },
      },
    });
    expect(first.receipt.transcript.appendedMessages[0]?.message).toMatchObject({
      __openclaw: {
        intent: { kind: "session-goal-start", goalId: "goal-1", operationId: "goal-operation" },
      },
    });
    const snapshot = actor.snapshot(authority)!;
    const replay = committed(await append(plan));
    expect(replay.value).toMatchObject({
      result: {
        sessionTurnMutationResult: {
          replayed: true,
          result: { goalId: "goal-1", runId: "goal-run" },
        },
      },
    });
    expect(replay.receipt.transcript.appendedMessages).toEqual([]);
    expect(actor.snapshot(authority)?.entry).toEqual(snapshot.entry);
    expect(replay.receipt.transcript.after).toEqual(snapshot.transcript.version);
    const identity = actor.target.database;
    if (identity.kind !== "memory") {
      throw new Error("Expected memory identity");
    }
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
    const { actor, append } = await fixture();
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
    const latest = committed(
      await append(
        turn([
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
        ]),
      ),
    );
    const user = latest.receipt.transcript.appendedMessages[0]?.anchor;
    if (!user) {
      throw new Error("Expected admitted user anchor");
    }
    const result = committed(
      await actor.appendTranscriptEvent(
        {
          commandId: "bounded",
          phaseId: "turn",
          append: {
            kind: "metadata",
            input: {
              scope: { agentId: "main", storePath: path, sessionKey, sessionId },
              event: {
                type: "message",
                id: "final",
                parentId: "display",
                timestamp: "1970-01-01T00:00:00.004Z",
              },
              message: {
                messageJson: JSON.stringify({ role: "assistant", content: "Answer" }),
                cwd: "/synthetic",
                validateTurn: true,
              },
              options: {},
              view: {
                loadedVersion: { generation: null, rawSeq: null, updatedAt: null },
                limits: { maxBytes: 4096, maxEvents: 2 },
                admission: { ...user, role: "user", logicalTurnId: "turn-2" },
              },
            },
          },
        },
        authority,
      ),
    );
    const appended = result.receipt.transcript.append;
    if (
      appended?.kind !== "metadata" ||
      !appended.value.reload?.ok ||
      appended.value.reload.value.kind !== "bounded"
    ) {
      throw new Error("Expected bounded reload");
    }
    const context = appended.value.reload.value.snapshot;
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
    expect(context.boundaryCount).toBe(1);
    expect(context.activeLeafEntryId).toBe("final");
    expect(context.truncated).toBe(true);
  });
});
