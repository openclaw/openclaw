import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileHarnessCompletionDelivery } from "../../agents/agent-harness-completion-delivery.js";
import { createHarnessCompletionSourceAssertion } from "../../agents/agent-harness-completion-recovery.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { lookupSessionGoalOperation } from "./goals-operations-read.js";
import { mutateSessionGoal } from "./goals-operations.js";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
} from "./restart-recovery-receipt.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
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
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
import { listSessionPendingInputs } from "./session-pending-input-history.js";
import { readSessionPendingInputReceiptsInWorker } from "./session-pending-input-receipts.js";
import { readPendingInputSource } from "./session-pending-input-source.js";
import { preparePendingInputStore } from "./session-pending-input-store.js";
import { discardSessionPendingInput } from "./session-pending-input-withdrawal.js";
import type { SessionPendingInputOwner } from "./session-pending-input.types.js";
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

afterEach(() => {
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
});

function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  if (outcome.kind !== "committed") {
    throw new Error(JSON.stringify(outcome));
  }
  return outcome.value;
}

async function fixture(patch: Partial<SessionEntry> = {}) {
  const owner = memorySessionActorOwners.get({ agentId: scope.agentId, path: scope.storePath });
  const acquire = async (): Promise<SessionActorStorageBinding> => {
    const binding = await acquireSessionActorStorage(scope, {
      lifetime: { assertCurrent() {}, assertReadable() {} },
      authority,
      create: true,
    });
    if (!binding) {
      throw new Error("Expected memory session acquisition");
    }
    return binding;
  };
  const binding = await acquire();
  const storage = binding.actor.storage!;
  committed(
    await storage.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true, ...patch } },
      },
      authority,
    ),
  );
  const append = async (event: unknown) => {
    const current = await acquire();
    try {
      return committed(
        await current.actor.storage!.mutate(
          {
            type: "session.metadata.append",
            input: { scope, event: JSON.stringify(event), options: {} },
          },
          authority,
        ),
      );
    } finally {
      await current.actor.release();
    }
  };
  const replace = async (next: Partial<SessionEntry>) => {
    const current = await acquire();
    try {
      const entry = current.actor.snapshot(authority)?.entry;
      if (!entry) {
        throw new Error("Expected current memory entry");
      }
      return committed(
        await current.actor.storage!.mutate(
          {
            type: "session.entry.replace",
            input: { expected: entry, entry: { ...entry, ...next } },
          },
          authority,
        ),
      );
    } finally {
      await current.actor.release();
    }
  };
  return { owner, binding, storage, acquire, append, replace };
}

describe("memory continuation adapters", () => {
  it("replays an unbound Goal operation without overwriting a newer edit", async () => {
    const now = Date.now();
    const { owner, binding, replace } = await fixture({
      goal: {
        schemaVersion: 1,
        id: "goal-1",
        objective: "Original",
        status: "active",
        createdAt: now,
        updatedAt: now,
        tokenStart: 0,
        tokenStartFresh: true,
        tokensUsed: 0,
        continuationTurns: 0,
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

  it("keeps live pending custody, then interrupts the retained window after reset", async () => {
    const { binding, storage, replace, acquire } = await fixture();
    const idempotencyKey = "pending:user";
    const messageJson = JSON.stringify({
      role: "user",
      content: "pending",
      idempotencyKey,
      timestamp: 1,
    });
    const expected = await storage.read(
      {
        type: "session.pendingInput.read",
        input: { ...scope, kind: "stage", idempotencyKey, trackCompletion: true },
      },
      authority,
    );
    if (expected.kind !== "stage") {
      throw new Error("Expected pending stage");
    }
    committed(
      await storage.mutate(
        {
          type: "session.pendingInput.mutate",
          input: {
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
          },
        },
        authority,
      ),
    );
    const pendingOwner: SessionPendingInputOwner = {
      ...scope,
      inputId: "pending-input",
      transcriptInputId: "pending-input",
      idempotencyKey,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      databasePath: scope.storePath,
      workerDatabasePath: scope.storePath,
      messageJson,
      assertCurrent() {},
      finish() {},
    };
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
          items: [{ id: "pending-input", state: "interrupted" }],
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
    const pendingOwner: SessionPendingInputOwner = {
      ...scope,
      inputId: "store-input",
      transcriptInputId: "store-input",
      idempotencyKey,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      databasePath: scope.storePath,
      workerDatabasePath: scope.storePath,
      messageJson: JSON.stringify({
        role: "user",
        content: "stored",
        idempotencyKey,
        timestamp: 1,
      }),
      assertCurrent() {},
      finish() {},
    };
    registerSessionPendingInputOwner(pendingOwner);
    const guard = () => assertSessionPendingInputLifetimeCurrent(pendingOwner);
    const store = await runWithSessionActorStorage(binding, () =>
      preparePendingInputStore(scope, guard),
    );
    try {
      const read = { ...scope, idempotencyKey, kind: "stage" as const, trackCompletion: true };
      const expected = await store.read(read);
      if (expected.kind !== "stage") {
        throw new Error("Expected pending stage");
      }
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
      expect(
        await store.mutate(
          { ...identity, kind: "complete", outcome: { reason: "failed", status: "error" } },
          guard,
        ),
      ).toMatchObject({ outcome: { reason: "completed", status: "ok" } });
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
    const message = {
      role: "user" as const,
      content: "recorded",
      timestamp: 1,
      idempotencyKey: "recorded:user",
    };
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
    if (!receipt?.completeAsync) {
      throw new Error("Expected complete input custody");
    }
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

  it("retains terminal ambiguity until an unbound actor records the provider outcome", async () => {
    const { owner, binding } = await fixture({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
    });
    const target = { ...scope, sourceTurnId: "source-turn", toolCallId: "send-1" };
    await binding.actor.release();
    expect(await beginRestartRecoveryTerminalDelivery(target)).toBe("started");
    expect(await beginRestartRecoveryTerminalDelivery(target)).toBe("delivery-ambiguous");
    expect(
      await cancelRestartRecoveryTerminalDelivery({ ...target, toolCallId: "wrong-send" }),
    ).toBe("stale");
    expect(await cancelRestartRecoveryTerminalDelivery(target)).toBe("cleared");
    expect(await beginRestartRecoveryTerminalDelivery(target)).toBe("started");
    expect(await completeRestartRecoveryTerminalDelivery(target)).toBe("recorded");
    expect(await beginRestartRecoveryTerminalDelivery(target)).toBe("already-delivered");
    expect(
      owner.readSession(scope.sessionKey, authority)?.entry?.restartRecoveryDeliveryReceiptState,
    ).toBe("delivered-terminal");
  });

  it.each(["human", "reset"])(
    "rechecks an unbound completion source after an in-process %s write",
    async (change) => {
      const claim: HarnessCompletionRecovery = {
        taskId: "child-task",
        taskRunId: "child-task",
        taskStatus: "succeeded",
        sourceRunId: "announce:child",
        requesterSessionKey: scope.sessionKey,
        requesterAgentId: scope.agentId,
        sessionId: scope.sessionId,
      };
      const { binding, append } = await fixture({
        restartRecoveryHarnessCompletion: claim,
        restartRecoveryDeliverySourceRunId: claim.sourceRunId,
        restartRecoveryDeliveryRunId: "recovery-run",
      });
      await append({
        type: "message",
        id: "completion-source",
        parentId: null,
        timestamp: "1970-01-01T00:00:00.001Z",
        message: {
          role: "user",
          content: "child result",
          idempotencyKey: `${claim.sourceRunId}:user`,
          __openclaw: { runId: claim.sourceRunId },
          provenance: {
            kind: "inter_session",
            sourceTool: "agent_harness_completion",
            sourceChannel: "internal",
            sourceSessionKey: claim.taskRunId,
          },
        },
      });
      await binding.actor.release();
      const request = { ...scope, sourceRunId: claim.sourceRunId };
      const effect = createHarnessCompletionSourceAssertion({
        claim,
        storePath: scope.storePath,
      });
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("pending");
      expect(effect).not.toThrow();
      await append(
        change === "human"
          ? {
              type: "message",
              id: "human",
              parentId: "completion-source",
              timestamp: "1970-01-01T00:00:00.002Z",
              message: { role: "user", content: "new work" },
            }
          : {
              type: "reset",
              id: "reset",
              parentId: "completion-source",
              timestamp: "1970-01-01T00:00:00.002Z",
              reason: "new",
              firstKeptEntryId: "completion-source",
            },
      );
      expect(effect).toThrow();
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("blocked");
    },
  );

  it("requires confirmed terminal delivery and blocks a submitted input after its claim is lost", async () => {
    const claim: HarnessCompletionRecovery = {
      taskId: "child-task",
      taskRunId: "child-task",
      taskStatus: "succeeded",
      sourceRunId: "announce:child",
      requesterSessionKey: scope.sessionKey,
      requesterAgentId: scope.agentId,
      sessionId: scope.sessionId,
    };
    const { binding, append, replace } = await fixture();
    const request = { ...scope, sourceRunId: claim.sourceRunId };
    await runWithSessionActorStorage(binding, async () => {
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("unowned");
      await append({
        type: "message",
        id: "submitted",
        parentId: null,
        timestamp: "1970-01-01T00:00:00.001Z",
        message: {
          role: "user",
          content: "child result",
          idempotencyKey: `${claim.sourceRunId}:user`,
        },
      });
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("blocked");
      const receipt = {
        runId: claim.sourceRunId,
        harnessCompletion: claim,
        deliveryContext: { channel: "discord", to: "channel:synthetic" },
        deliveryStatus: { status: "sent" as const, resultCount: 0 },
        payloads: [{ visible: true }],
      };
      await replace({ restartRecoveryTerminalDeliveryEvidence: [receipt] });
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("blocked");
      await replace({
        restartRecoveryTerminalDeliveryEvidence: [
          { ...receipt, deliveryStatus: { status: "sent", resultCount: 1 } },
        ],
      });
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("delivered");
    });
  });
});
