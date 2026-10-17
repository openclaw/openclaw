import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { loadSessionTranscriptEvents } from "./session-transcript-events.js";
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
const database = { agentId: scope.agentId, path: scope.storePath };
const initialSessionEntry = { sessionId, updatedAt: 1, incognito: true };
type TurnOptions = Omit<SqliteSessionTurnOptions, "expectedSessionId" | "sessionFile">;
const turn = (options: TurnOptions) => ({
  expectedSessionId: sessionId,
  sessionFile: "synthetic-session.jsonl",
  config: {},
  ...options,
});
const user = (content: string, idempotencyKey?: string) => ({
  role: "user",
  content,
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});
const appended = (message: unknown, fresh = true, extra = {}) =>
  expect.objectContaining({ appended: fresh, message, ...extra });
const missing = (result: Promise<unknown>) =>
  expect(result).rejects.toMatchObject({ code: "INCOGNITO_SESSION_MISSING" });
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
  memorySessionActorOwners.closeDatabase(database);
});

async function fixture(boundAuthority = authority) {
  const owner = createMemorySessionActorOwner(database);
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const storage = actor.storage!;
  const initialized = await storage.mutate(
    {
      type: "session.metadata.initialize",
      input: { scope, entry: initialSessionEntry },
    },
    authority,
  );
  expect(initialized.kind).toBe("committed");
  const append = (options: TurnOptions) =>
    runWithSessionActorStorage({ actor, authority: boundAuthority, ...database }, () =>
      appendExpectedSessionTranscriptTurn(scope, turn(options)),
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
    await appendExpectedSessionTranscriptTurn(
      scope,
      turn({
        initialSessionEntry,
        messages: [{ eventId: "raw-user", message: user("Input") }],
      }),
    );
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
    const before = await loadSessionTranscriptEvents(scope);
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
    expect(await loadSessionTranscriptEvents(scope)).toEqual(before);
    memorySessionActorOwners.closeSession(database, sessionKey);
    await missing(appendPreparedTranscriptEvent(scope, { type: "custom", id: "closed" }, () => {}));
    expect(await loadSessionTranscriptEvents(scope)).toEqual([]);
  });

  it("acquires an unbound incognito owner for turns and notifications without recreating closed sessions", async () => {
    const options = turn({ messages: [{ message: user("First input", "first") }] });
    await missing(appendExpectedSessionTranscriptTurn(scope, options));
    expect(memorySessionActorOwners.read(database)).toBeUndefined();
    const created = await appendExpectedSessionTranscriptTurn(scope, {
      ...options,
      initialSessionEntry,
    });
    expect(created.appendedMessages).toEqual([appended(options.messages[0]!.message)]);
    const followup = await appendExpectedSessionTranscriptTurn(scope, {
      ...options,
      messages: [{ message: user("Follow-up", "follow-up") }],
    });
    expect(followup.appendedMessages).toEqual([
      appended(expect.objectContaining({ content: "Follow-up" })),
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
      memorySessionActorOwners.closeSession(database, sessionKey);
      await missing(publishTranscriptUpdate(scope));
      await missing(appendExpectedSessionTranscriptTurn(scope, options));
      expect(notified).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("preserves both simultaneous transcript appends", async () => {
    const { append, history } = await fixture();
    const messages = [user("First concurrent input"), user("Second concurrent input")];
    const results = await Promise.allSettled(
      messages.map((message) => append({ messages: [{ message }] })),
    );
    expect(results).toEqual(
      messages.map((message) => ({
        status: "fulfilled",
        value: expect.objectContaining({ appendedMessages: [appended(message)] }),
      })),
    );
    expect(
      (await history()).events.filter((event) => isRecord(event) && event.type === "message"),
    ).toEqual(messages.map((message) => expect.objectContaining({ type: "message", message })));
  });

  it("prepares fresh input once and publishes the same canonical bytes on retry", async () => {
    const { actor, owner, append, history } = await fixture();
    const original = user("Original", "input-1");
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
    expect(first.appendedMessages).toEqual([appended(accepted)]);
    const before = await history();
    const retry = await append(options);
    expect(retry.appendedMessages).toEqual([
      appended(accepted, false, { messageId: first.appendedMessages[0]!.messageId }),
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
    const options: TurnOptions = {
      messages: [{ message: user("Start", "goal-input") }],
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
      __openclaw: { intent: { kind: "session-goal-start", goalId, operationId: "goal-start" } },
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
        return user("Must not persist", "revoked");
      });
      const onMessageCommitted = vi.fn();
      await expect(
        append({
          messages: [
            {
              message: user("Original", "revoked"),
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
