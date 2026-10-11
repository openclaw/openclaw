import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
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
