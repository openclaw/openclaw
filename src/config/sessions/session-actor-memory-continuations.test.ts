import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { lookupSessionGoalOperation } from "./goals-operations-read.js";
import { mutateSessionGoal } from "./goals-operations.js";
import { buildCreatedSessionGoal } from "./goals-transitions.js";
import {
  stageSessionPendingInput,
  bindSessionPendingInputSources,
  readSessionSubmittedInput,
} from "./session-accessor.pending-inputs.js";
import {
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
  assertSessionPendingInputLifetimeCurrent,
} from "./session-accessor.sqlite-pending-inputs.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { commitMemory, readMemory } from "./session-actor-memory-publication.test-support.js";
import { acquireSessionActorStorage } from "./session-actor-storage-acquisition.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { listSessionPendingInputs } from "./session-pending-input-history.js";
import type { SessionPendingInputOwner } from "./session-pending-input-owner.types.js";
import { readSessionPendingInputReceiptsInWorker } from "./session-pending-input-receipts.js";
import { readPendingInputSource } from "./session-pending-input-source.js";
import { preparePendingInputStore } from "./session-pending-input-store.js";
import { discardSessionPendingInput } from "./session-pending-input-withdrawal.js";
import type { SessionEntry } from "./types.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory continuation opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory continuation allocated a worker");
  }),
}));

const scope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:incognito-continuations",
  sessionId: "window-1",
  storePath: resolveIncognitoOpenClawAgentSqlitePath({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: "/synthetic/continuations" },
  }),
};
const authority = { assertCurrent() {}, authorize() {} };
const userMessage = (content: string, idempotencyKey: string) => ({
  role: "user" as const,
  content,
  idempotencyKey,
  timestamp: 1,
});

afterEach(() => {
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
});

const makePendingOwner = (
  inputId: string,
  idempotencyKey: string,
  messageJson: string,
): SessionPendingInputOwner => ({
  ...scope,
  inputId,
  transcriptInputId: inputId,
  idempotencyKey,
  messageJson,
  lifecycleGeneration: getAgentEventLifecycleGeneration(),
  databasePath: scope.storePath,
  workerDatabasePath: scope.storePath,
  assertCurrent() {},
  finish() {},
});

async function fixture(patch: Partial<SessionEntry> = {}) {
  const owner = memorySessionActorOwners.get({ agentId: scope.agentId, path: scope.storePath });
  const acquire = async (): Promise<SessionActorStorageBinding> => {
    const binding = await acquireSessionActorStorage(scope, {
      lifetime: { assertCurrent() {}, assertReadable() {} },
      authority,
      create: true,
    });
    assert(binding, "Expected memory session acquisition");
    return binding;
  };
  const binding = await acquire();
  const storage = binding.actor.storage!;
  await commitMemory(storage, "session.entry.create", {
    entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true, ...patch },
  });
  const replace = async (next: Partial<SessionEntry>) => {
    const current = await acquire();
    try {
      const entry = current.actor.snapshot(authority)?.entry;
      assert(entry, "Expected current memory entry");
      return await commitMemory(current.actor.storage!, "session.entry.replace", {
        expected: entry,
        entry: { ...entry, ...next },
      });
    } finally {
      await current.actor.release();
    }
  };
  return { owner, binding, storage, acquire, replace };
}

describe("memory continuation adapters", () => {
  it("replays an unbound Goal operation without overwriting a newer edit", async () => {
    const now = Date.now();
    const { owner, binding, replace } = await fixture({
      goal: {
        ...buildCreatedSessionGoal(
          { sessionId: scope.sessionId, updatedAt: now },
          { objective: "Original" },
          now,
        ),
        id: "goal-1",
        tokenStartFresh: true,
      },
    });
    const input = {
      ...scope,
      expectedSessionId: scope.sessionId,
      operation: {
        action: "edit" as const,
        goalId: "goal-1",
        operationId: "edit-1",
        requestFingerprint: "request-1",
        issuedAtMs: now,
        objective: "First",
      },
    };
    await binding.actor.release();
    expect(await mutateSessionGoal(input)).toMatchObject({ replayed: false });
    await mutateSessionGoal({
      ...input,
      operation: { ...input.operation, operationId: "edit-2", objective: "Second" },
    });
    expect(await lookupSessionGoalOperation(input)).toMatchObject({
      goal: { objective: "First" },
    });
    expect(await mutateSessionGoal(input)).toMatchObject({ replayed: true });
    expect(owner.readSession(scope.sessionKey, authority)?.entry?.goal?.objective).toBe("Second");
    await expect(
      mutateSessionGoal({ ...input, operation: { ...input.operation, objective: "Conflict" } }),
    ).rejects.toMatchObject({ name: "SessionGoalOperationError", code: "operation-conflict" });
    await replace({ sessionId: "window-2" });
    await expect(lookupSessionGoalOperation(input)).rejects.toMatchObject({
      name: "SessionGoalOperationError",
      code: "session-rebound",
    });
  });

  it("keeps live pending custody, then hides the retired window after reset", async () => {
    const { binding, storage, replace, acquire } = await fixture();
    const idempotencyKey = "pending:user";
    const messageJson = JSON.stringify(userMessage("pending", idempotencyKey));
    const expected = await readMemory(storage, "session.pendingInput.read", {
      ...scope,
      kind: "stage",
      idempotencyKey,
      trackCompletion: true,
    });
    assert(expected.kind === "stage", "Expected pending stage");
    await commitMemory(storage, "session.pendingInput.mutate", {
      ...scope,
      kind: "stage",
      idempotencyKey,
      trackCompletion: true,
      expected,
      inputId: "pending-input",
      messageJson,
      runId: "pending",
      requestHash: "hash",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    const pendingOwner = makePendingOwner("pending-input", idempotencyKey, messageJson);
    registerSessionPendingInputOwner(pendingOwner);
    try {
      await runWithSessionActorStorage(binding, async () => {
        expect(await readPendingInputSource(scope, idempotencyKey, false)).toMatchObject({
          snapshot: { current: true, pending: { input_id: "pending-input" } },
        });
        expect(await listSessionPendingInputs(scope)).toMatchObject({
          items: [{ id: "pending-input", state: "queued" }],
        });
        await expect(discardSessionPendingInput(scope, "pending", () => {})).rejects.toThrow(
          "use Stop",
        );
      });
      await replace({ sessionId: "window-2" });
      const current = await acquire();
      await runWithSessionActorStorage(current, async () => {
        expect(await listSessionPendingInputs(scope)).toMatchObject({
          items: [],
        });
        const fresh = await readPendingInputSource(
          { ...scope, sessionId: "window-2" },
          idempotencyKey,
          false,
        );
        expect(fresh).toMatchObject({ snapshot: { current: true } });
        expect(fresh?.snapshot.pending).toBeUndefined();
      });
    } finally {
      releaseSessionPendingInputOwner(pendingOwner);
    }
  });

  it("settles input through the store adapter without losing an intervening session patch", async () => {
    const { owner, binding, replace } = await fixture();
    const idempotencyKey = "store:user";
    const pendingOwner = makePendingOwner(
      "store-input",
      idempotencyKey,
      JSON.stringify(userMessage("stored", idempotencyKey)),
    );
    registerSessionPendingInputOwner(pendingOwner);
    const guard = () => assertSessionPendingInputLifetimeCurrent(pendingOwner);
    const store = await runWithSessionActorStorage(binding, () =>
      preparePendingInputStore(scope, guard),
    );
    try {
      const read = { ...scope, idempotencyKey, kind: "stage" as const, trackCompletion: true };
      const expected = await store.read(read);
      assert(expected.kind === "stage", "Expected pending stage");
      const identity = {
        ...scope,
        idempotencyKey,
        runId: "store-run",
        requestHash: "store-request",
        lifecycleGeneration: pendingOwner.lifecycleGeneration,
      };
      await store.mutate(
        {
          ...identity,
          kind: "stage",
          expected,
          trackCompletion: true,
          inputId: pendingOwner.inputId,
          messageJson: pendingOwner.messageJson,
        },
        guard,
      );
      expect(await store.read(read)).toMatchObject({ existing: { input_id: "store-input" } });
      await replace({ label: "Intervening edit" });
      await store.mutate(
        { ...identity, kind: "complete", outcome: { reason: "completed", status: "ok" } },
        guard,
      );
      expect(await store.read(read)).toMatchObject({
        existing: undefined,
        previous: { outcome: { reason: "completed", status: "ok" } },
      });
      expect(binding.actor.snapshot(authority)?.entry?.label).toBe("Intervening edit");
      owner.close();
      expect(store.assertCurrent).toThrow();
    } finally {
      releaseSessionPendingInputOwner(pendingOwner);
      await store.release();
    }
  });

  it("acquires unbound input custody and retains it through collected receipt callbacks", async () => {
    const { owner, binding } = await fixture();
    const message = userMessage("recorded", "recorded:user");
    const options = {
      message,
      runId: "recorded",
      requestFingerprint: "recorded-request",
      trackCompletion: true,
      assertCurrent() {},
    };
    await binding.actor.release();
    const target = scope;
    const receipt = await stageSessionPendingInput(target, options);
    assert(receipt?.completeAsync, "Expected complete input custody");
    try {
      expect(
        await readSessionPendingInputReceiptsInWorker(scope, { runIds: ["recorded"] }),
      ).toEqual([{ runId: "recorded", state: "pending" }]);
      expect(
        await receipt.run(() => readSessionSubmittedInput(scope, message.idempotencyKey)),
      ).toEqual(message);
      const collected = bindSessionPendingInputSources([receipt], {
        ...message,
        idempotencyKey: "collected:user",
      });
      expect(
        await collected?.runAsync?.(() => readSessionSubmittedInput(scope, message.idempotencyKey)),
      ).toEqual(message);
      expect(await receipt.completeAsync({ reason: "completed", status: "ok" })).toEqual({
        reason: "completed",
        status: "ok",
      });
    } finally {
      receipt.finish("interrupted");
      await receipt.settled?.();
    }
    expect(await stageSessionPendingInput(target, options)).toMatchObject({
      state: "consumed",
      completion: { reason: "completed", status: "ok" },
    });
    owner.closeSession(scope.sessionKey);
    await expect(stageSessionPendingInput(target, options)).rejects.toThrow("closed or removed");
    expect(await readPendingInputSource(scope, message.idempotencyKey, false)).toBeUndefined();
    expect(await listSessionPendingInputs(scope)).toMatchObject({ items: [] });
    expect(await readSessionPendingInputReceiptsInWorker(scope, { runIds: ["recorded"] })).toEqual(
      [],
    );
    await expect(discardSessionPendingInput(scope, "recorded", () => {})).rejects.toThrow(
      "use Stop",
    );
    expect(owner.readSession(scope.sessionKey, authority)).toBeUndefined();
  });
});
