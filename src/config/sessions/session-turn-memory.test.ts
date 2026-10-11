import { afterEach, describe, expect, it, vi } from "vitest";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import { appendPreparedTranscriptEvent } from "./session-transcript-event.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import type { SqliteSessionTurnOptions } from "./session-turn.types.js";

// The public turn path must neither open SQLite nor allocate worker capacity for memory sessions.
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory turn opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory turn allocated a worker");
  }),
}));

const sessionKey = "agent:main:dashboard:incognito-turn";
const sessionId = "session-1";
const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-turn" };
const scope = {
  agentId: "main",
  sessionKey,
  sessionId,
  env,
  storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
});

async function fixture(boundAuthority = authority) {
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const storage = actor.storage!;
  const initialized = await storage.mutate(
    {
      type: "session.metadata.initialize",
      input: { scope, entry: { sessionId, updatedAt: 1, incognito: true } },
    },
    authority,
  );
  expect(initialized.kind).toBe("committed");
  const append = (options: Omit<SqliteSessionTurnOptions, "expectedSessionId" | "sessionFile">) =>
    runWithSessionActorStorage(
      { actor, authority: boundAuthority, agentId: scope.agentId, path: scope.storePath },
      () =>
        appendExpectedSessionTranscriptTurn(scope, {
          expectedSessionId: sessionId,
          sessionFile: "synthetic-session.jsonl",
          config: {},
          ...options,
        }),
    );
  const history = async () => {
    const read = await storage.read(
      { type: "session.history.hydrate", input: { sessionId } },
      authority,
    );
    if (read.kind !== "full") {
      throw new Error("Expected full memory history");
    }
    return read.snapshot;
  };
  return { actor, owner, append, history };
}

describe("memory actor transcript turn binding", () => {
  it("preserves raw events and duplicate results through the unbound writer without bypassing authority", async () => {
    await appendExpectedSessionTranscriptTurn(scope, {
      expectedSessionId: sessionId,
      sessionFile: "synthetic-session.jsonl",
      config: {},
      initialSessionEntry: { sessionId, updatedAt: 1, incognito: true },
      messages: [{ eventId: "raw-user", message: { role: "user", content: "Input" } }],
    });
    const events = [
      {
        type: "custom",
        id: "raw-custom",
        parentId: "raw-user",
        timestamp: 2,
        appendMode: "side",
        data: { result: "retained" },
      },
      { type: "leaf", id: "raw-leaf", parentId: "raw-user", targetId: "raw-user" },
    ];
    for (const event of events) {
      expect(await appendPreparedTranscriptEvent(scope, event, () => {})).toBe(true);
      expect(await appendPreparedTranscriptEvent(scope, event, () => {})).toBe(false);
    }
    const before = await loadTranscriptEvents(scope);
    expect(before.slice(-2)).toEqual(events);
    await expect(
      appendPreparedTranscriptEvent(
        { ...scope, expectedWriterRunId: "stale-writer" },
        { type: "custom", id: "refused-writer" },
        () => {},
      ),
    ).rejects.toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
    await expect(
      appendPreparedTranscriptEvent(scope, { type: "custom", id: "refused-authority" }, () => {
        throw new Error("Event authority ended");
      }),
    ).rejects.toThrow("Event authority ended");
    expect(await loadTranscriptEvents(scope)).toEqual(before);
    memorySessionActorOwners.closeSession(
      { agentId: scope.agentId, path: scope.storePath },
      sessionKey,
    );
    await expect(
      appendPreparedTranscriptEvent(scope, { type: "custom", id: "closed" }, () => {}),
    ).rejects.toMatchObject({ code: "INCOGNITO_SESSION_MISSING" });
    expect(await loadTranscriptEvents(scope)).toEqual([]);
  });

  it("acquires an unbound incognito owner for turns and notifications without recreating closed sessions", async () => {
    const options = {
      expectedSessionId: sessionId,
      sessionFile: "synthetic-session.jsonl",
      config: {},
      messages: [{ message: { role: "user", content: "First input", idempotencyKey: "first" } }],
    };
    await expect(appendExpectedSessionTranscriptTurn(scope, options)).rejects.toMatchObject({
      code: "INCOGNITO_SESSION_MISSING",
    });
    expect(
      memorySessionActorOwners.read({ agentId: scope.agentId, path: scope.storePath }),
    ).toBeUndefined();
    const created = await appendExpectedSessionTranscriptTurn(scope, {
      ...options,
      initialSessionEntry: { sessionId, updatedAt: 1, incognito: true },
    });
    expect(created.appendedMessages).toEqual([
      expect.objectContaining({ appended: true, message: options.messages[0]!.message }),
    ]);
    const followup = await appendExpectedSessionTranscriptTurn(scope, {
      ...options,
      messages: [{ message: { role: "user", content: "Follow-up", idempotencyKey: "follow-up" } }],
    });
    expect(followup.appendedMessages).toEqual([
      expect.objectContaining({
        appended: true,
        message: expect.objectContaining({ content: "Follow-up" }),
      }),
    ]);
    const notified = vi.fn();
    const unsubscribe = onInternalSessionTranscriptUpdate(notified);
    try {
      await publishTranscriptUpdate(scope, { messageId: followup.appendedMessages[0]!.messageId });
      expect(notified).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { agentId: scope.agentId, sessionId, sessionKey, storePath: scope.storePath },
          messageId: followup.appendedMessages[0]!.messageId,
        }),
      );
      notified.mockClear();
      memorySessionActorOwners.closeSession(
        { agentId: scope.agentId, path: scope.storePath },
        sessionKey,
      );
      await expect(publishTranscriptUpdate(scope)).rejects.toMatchObject({
        code: "INCOGNITO_SESSION_MISSING",
      });
      await expect(appendExpectedSessionTranscriptTurn(scope, options)).rejects.toMatchObject({
        code: "INCOGNITO_SESSION_MISSING",
      });
      expect(notified).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("preserves both simultaneous transcript appends", async () => {
    const { append, history } = await fixture();
    const messages = [
      { role: "user", content: "First concurrent input" },
      { role: "user", content: "Second concurrent input" },
    ];
    const results = await Promise.allSettled(
      messages.map((message) => append({ messages: [{ message }] })),
    );
    expect(results).toEqual(
      messages.map((message) => ({
        status: "fulfilled",
        value: expect.objectContaining({
          appendedMessages: [expect.objectContaining({ appended: true, message })],
        }),
      })),
    );
    expect((await history()).events.filter((event) => event.type === "message")).toEqual(
      messages.map((message) => expect.objectContaining({ type: "message", message })),
    );
  });

  it("prepares fresh input once and publishes the same canonical bytes on retry", async () => {
    const { actor, owner, append, history } = await fixture();
    const original = { role: "user", content: "Original", idempotencyKey: "input-1" };
    const accepted = { ...original, content: "Prepared input" };
    const prepareMessage = vi.fn(async () => accepted);
    const onMessageCommitted = vi.fn();
    const onCommittedSource = vi.fn();
    const options = {
      messages: [{ message: original, preparation: { prepareMessage } }],
      onMessageCommitted,
      onCommittedSource,
    };
    const first = await append(options);
    expect(first.appendedMessages).toEqual([
      expect.objectContaining({ appended: true, message: accepted }),
    ]);
    const before = await history();
    const retry = await append(options);
    expect(retry.appendedMessages).toEqual([
      expect.objectContaining({
        appended: false,
        message: accepted,
        messageId: first.appendedMessages[0]!.messageId,
      }),
    ]);
    expect(prepareMessage).toHaveBeenCalledOnce();
    expect(onMessageCommitted).toHaveBeenCalledTimes(2);
    expect(onCommittedSource).toHaveBeenLastCalledWith(
      {
        agentId: scope.agentId,
        path: scope.storePath,
        databaseIdentity: owner.identity.incarnation,
      },
      expect.objectContaining({ sessionId, incognito: true }),
    );
    expect((await history()).eventJson).toEqual(before.eventJson);
    expect(actor.snapshot(authority)?.transcript.anchors).toHaveLength(1);
  });

  it("prepares a Goal turn from its memory owner and replays the receipt without another append", async () => {
    const { actor, append, history } = await fixture();
    const options: Omit<SqliteSessionTurnOptions, "expectedSessionId" | "sessionFile"> = {
      messages: [{ message: { role: "user", content: "Start", idempotencyKey: "goal-input" } }],
      sessionTurnMutation: {
        kind: "goal",
        runId: "goal-run",
        operation: {
          action: "start",
          objective: "Finish the task",
          operationId: "goal-start",
          requestFingerprint: "goal-request",
          issuedAtMs: Date.now(),
        },
      },
    };
    const first = await append(options);
    expect(first.sessionTurnMutationResult).toMatchObject({
      replayed: false,
      result: { runId: "goal-run", goal: { objective: "Finish the task" } },
    });
    const goalId = first.sessionTurnMutationResult!.result.goalId;
    expect(first.appendedMessages[0]?.message).toMatchObject({
      __openclaw: {
        intent: { kind: "session-goal-start", goalId, operationId: "goal-start" },
      },
    });
    const before = await history();
    const retry = await append(options);
    expect(retry.sessionTurnMutationResult).toEqual({
      result: first.sessionTurnMutationResult!.result,
      replayed: true,
    });
    expect(retry.appendedMessages).toEqual([]);
    expect((await history()).eventJson).toEqual(before.eventJson);
    expect(actor.snapshot(authority)?.entry?.goal?.id).toBe(goalId);
  });

  it.each(["source", "binding"] as const)(
    "does not commit after %s authority is revoked during awaited preparation",
    async (revoked) => {
      let current = true;
      const refusal = new Error("Turn authority revoked");
      const assertCurrent = () => {
        if (!current) {
          throw refusal;
        }
      };
      const { append, history } = await fixture(
        revoked === "binding" ? { assertCurrent, authorize: assertCurrent } : authority,
      );
      const source = Object.assign(assertCurrent, {
        prepareSessionSource: async () => ({ assertCurrent, checks: [] }),
      });
      const prepareMessage = vi.fn(async () => {
        await Promise.resolve();
        current = false;
        return { role: "user", content: "Must not persist", idempotencyKey: "revoked" };
      });
      const onMessageCommitted = vi.fn();
      await expect(
        append({
          messages: [
            {
              message: { role: "user", content: "Original", idempotencyKey: "revoked" },
              preparation: { prepareMessage, ...(revoked === "source" ? { source } : {}) },
            },
          ],
          onMessageCommitted,
        }),
      ).rejects.toBe(refusal);
      expect(prepareMessage).toHaveBeenCalledOnce();
      expect(onMessageCommitted).not.toHaveBeenCalled();
      expect((await history()).events).toEqual([]);
    },
  );
});
