import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  createAgentRunStaleLifecycleError,
  isAgentRunStaleLifecycleError,
  isRestartRecoveryClaimChangedError,
} from "../../infra/agent-lifecycle-error.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { clearOpenClawAgentDatabaseValidationCache } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { handleReplyAgentRunError } from "./agent-runner-core.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withTrackedReply(
  test: (fixture: {
    controller: ReturnType<typeof createReplyRestartRecoveryClaimController>;
    operation: ReplyOperation;
    confirmArmed: () => Promise<void>;
    replaceWithSuccessor: () => Promise<void>;
    releaseDatabase: () => Promise<void>;
    readEntry: () => ReturnType<typeof loadSessionEntry>;
  }) => Promise<void>,
  storage: "durable" | "native-incognito" = "durable",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey:
        storage === "native-incognito"
          ? "agent:main:dashboard:incognito-recovery"
          : "agent:main:retired-readiness",
      storePath:
        storage === "native-incognito"
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
          : state.statePath("sessions.json"),
    };
    let entry: InternalSessionEntry = {
      sessionId: "old-session",
      updatedAt: 1,
      status: undefined,
      restartRecoveryDeliveryRunId: "old-recovery",
      ...(storage === "native-incognito" ? { incognito: true } : {}),
    };
    await replaceSessionEntry(scope, entry);
    const native =
      storage === "native-incognito"
        ? getOpenClawAgentDatabaseIfOpen({ ...scope, path: scope.storePath })
        : undefined;
    const operation = createReplyOperation({
      ...scope,
      sessionId: entry.sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    await using actor = createReplyRecoveryActorFixture({
      ...scope,
      getSessionId: () => operation.sessionId,
      operation,
    });
    const controller = createReplyRestartRecoveryClaimController({
      ...scope,
      acquireSessionActor: () => actor.acquireSessionActor(),
      admissionRunId: "old-recovery",
      lifecycleGeneration: operation.lifecycleGeneration,
      getEntry: () => entry,
      getSessionId: () => operation.sessionId,
      isRestartAbort: () =>
        operation.result?.kind === "aborted" && operation.result.code === "aborted_for_restart",
      resolveDeliveryContext: () => undefined,
      setEntry: (value) => {
        entry = value;
      },
    });
    try {
      await controller.admitUserTurn();
      await test({
        controller,
        operation,
        async confirmArmed() {
          entry = { ...entry, abortedLastRun: true };
          await replaceSessionEntry(scope, entry);
          expect(await controller.isArmed()).toBe(true);
        },
        async replaceWithSuccessor() {
          entry = {
            sessionId: "successor-session",
            updatedAt: 2,
            status: undefined,
            abortedLastRun: true,
            restartRecoveryDeliveryRunId: "successor-recovery",
          };
          await replaceSessionEntry(scope, entry);
        },
        readEntry: () => loadSessionEntry(scope),
        releaseDatabase: () => actor.release(),
      });
      if (storage === "native-incognito") {
        expect(native).toBeDefined();
        expect(getOpenClawAgentDatabaseIfOpen({ ...scope, path: scope.storePath })).toBe(native);
        expect(fs.existsSync(scope.storePath)).toBe(false);
      }
    } finally {
      operation.complete();
    }
  });
}

it("settles native-incognito recovery through hook checkpoints and restart readiness", async () => {
  await withTrackedReply(async ({ controller, operation, confirmArmed, readEntry }) => {
    await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
    await controller.checkpointBeforeAgentReply({ state: "handled-silent" });
    expect(readEntry()?.restartRecoveryBeforeAgentReplyState).toBe("handled-silent");
    await confirmArmed();
    operation.abortForRestart();
    let drains = 0;
    const reply = await handleReplyAgentRunError(new Error("Backend stopped"), {
      resolveVisibleReplyDelivery: async () => false,
      isHeartbeat: false,
      replyExpectation: "required",
      isRestartRecoveryArmed: controller.isArmed,
      replyOperation: operation,
      resolvedVerboseLevel: "off",
      returnWithQueuedFollowupDrain: (value) => {
        drains += 1;
        return value;
      },
      sessionCtx: {},
    });
    expect(reply?.text).toBe(SILENT_REPLY_TOKEN);
    expect(drains).toBe(1);
    expect(readEntry()).toMatchObject({
      sessionId: "old-session",
      restartRecoveryDeliveryRunId: "old-recovery",
      abortedLastRun: true,
    });
  }, "native-incognito");
});

it.each([
  { stage: "before-read", confirmed: false },
  { stage: "before-read", confirmed: true },
  { stage: "during-read", confirmed: false },
  { stage: "during-read", confirmed: true },
  { stage: "same-generation", confirmed: false },
  { stage: "cold-registration", confirmed: false },
  { stage: "cold-registration", confirmed: true },
] as const)(
  "settles restart readiness without adopting successor facts ($stage, confirmed=$confirmed)",
  async ({ stage, confirmed }) => {
    await withTrackedReply(
      async ({
        controller,
        operation,
        confirmArmed,
        replaceWithSuccessor,
        readEntry,
        releaseDatabase,
      }) => {
        if (confirmed) {
          await confirmArmed();
        }
        let restore: (() => void) | undefined;
        let assertBoundary: () => void;
        let drains = 0;
        try {
          if (stage === "cold-registration") {
            await releaseDatabase();
            await closeOpenClawAgentDatabasesAsync();
            clearOpenClawAgentDatabaseValidationCache();
            let witnessed = 0;
            const admission = probe.admission(workerAdmission, (request, grant, admit) => {
              if (
                request.stage === "prepare" &&
                isRecord(request.facts) &&
                request.facts.kind === "agent-registration-committed"
              ) {
                witnessed += 1;
                rotateAgentEventLifecycleGeneration();
              }
              admit(request, grant);
            });
            restore = () => admission.mockRestore();
            assertBoundary = () => {
              expect(witnessed).toBe(1);
              expect(readEntry()).toMatchObject({ sessionId: "old-session" });
            };
            operation.abortForRestart();
          } else {
            const read = entryReads.readSessionEntryInWorker;
            const reads = vi.spyOn(entryReads, "readSessionEntryInWorker");
            restore = () => reads.mockRestore();
            assertBoundary = () => {
              expect(reads).toHaveBeenCalledTimes(stage === "before-read" ? 0 : 1);
              expect(readEntry()).toMatchObject({
                sessionId: "successor-session",
                restartRecoveryDeliveryRunId: "successor-recovery",
                abortedLastRun: true,
              });
            };
            operation.abortForRestart();
            if (stage === "before-read") {
              rotateAgentEventLifecycleGeneration();
              await replaceWithSuccessor();
            } else {
              reads.mockImplementationOnce(async (...args) => {
                const result = await read(...args);
                if (stage === "during-read") {
                  rotateAgentEventLifecycleGeneration();
                }
                await replaceWithSuccessor();
                return result;
              });
            }
          }
          const reply = await handleReplyAgentRunError(new Error("Backend stopped"), {
            resolveVisibleReplyDelivery: async () => false,
            isHeartbeat: false,
            replyExpectation: "required",
            isRestartRecoveryArmed: controller.isArmed,
            replyOperation: operation,
            resolvedVerboseLevel: "off",
            returnWithQueuedFollowupDrain: (value) => {
              drains += 1;
              return value;
            },
            sessionCtx: {},
          });
          expect(reply?.text).toBe(
            confirmed
              ? SILENT_REPLY_TOKEN
              : "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
          );
          expect(drains).toBe(1);
          assertBoundary();
        } finally {
          restore?.();
        }
      },
    );
  },
);

it.each(["active-storage", "retired-storage", "retired-cleanup"] as const)(
  "preserves readiness failures outside the retired lifecycle refusal (%s)",
  async (failure) => {
    await withTrackedReply(async ({ controller, operation }) => {
      const storageError = new Error("Storage unavailable");
      const staleError = createAgentRunStaleLifecycleError();
      const expected =
        failure === "retired-cleanup"
          ? createSqliteLifecycleAggregateError(
              [staleError, storageError],
              "Read and cleanup failed",
              staleError,
            )
          : storageError;
      const reads = vi
        .spyOn(entryReads, "readSessionEntryInWorker")
        .mockImplementationOnce(async () => {
          if (failure !== "active-storage") {
            rotateAgentEventLifecycleGeneration();
          }
          throw expected;
        });
      try {
        operation.abortForRestart();
        await expect(controller.isArmed()).rejects.toBe(expected);
      } finally {
        reads.mockRestore();
      }
    });
  },
);

describe("restart recovery claim settlement", () => {
  it.each([
    { receiptState: undefined, expectedStatus: "done" },
    { receiptState: "terminal-pending" as const, expectedStatus: "failed" },
  ])(
    "clears lifecycle ownership when claim cleanup settles $expectedStatus",
    async ({ receiptState, expectedStatus }) => {
      const root = tempDirs.make(`openclaw-reply-claim-${expectedStatus}-`);
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:main";
      const sessionId = "session";
      let entry: InternalSessionEntry = {
        abortedLastRun: false,
        lifecycleRunId: "recovery-run",
        restartRecoveryDeliveryRunId: "recovery-run",
        sessionId,
        startedAt: 1,
        status: undefined,
        updatedAt: 1,
      };
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      await using actor = createReplyRecoveryActorFixture({
        agentId: "main",
        storePath,
        sessionKey,
        getSessionId: () => sessionId,
      });
      const controller = createReplyRestartRecoveryClaimController({
        agentId: "main",
        acquireSessionActor: () => actor.acquireSessionActor(),
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        admissionRunId: "recovery-run",
        getEntry: () => entry,
        getSessionId: () => sessionId,
        isRestartAbort: () => false,
        resolveDeliveryContext: () => undefined,
        sessionKey,
        setEntry: (next) => {
          entry = next;
        },
        storePath,
      });

      await expect(controller.admitUserTurn()).resolves.toBe("admitted");
      if (receiptState) {
        entry = (await updateSessionEntry({ storePath, sessionKey }, () => ({
          restartRecoveryDeliveryReceiptState: receiptState,
        }))) as InternalSessionEntry;
      } else {
        await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
        await controller.checkpointBeforeAgentReply({ state: "handled-silent" });
      }
      await controller.clear();

      const persisted = loadSessionEntry({ storePath, sessionKey }) as InternalSessionEntry;
      expect(persisted.status).toBe(expectedStatus);
      expect(persisted.lifecycleRunId).toBeUndefined();
    },
  );

  it("preserves lifecycle ownership when cleanup observes a restart abort", async () => {
    const root = tempDirs.make("openclaw-reply-claim-restart-abort-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "session";
    let restartAborted = false;
    let entry: InternalSessionEntry = {
      abortedLastRun: false,
      lifecycleRunId: "recovery-run",
      restartRecoveryDeliveryRunId: "recovery-run",
      sessionId,
      startedAt: 1,
      status: undefined,
      updatedAt: 1,
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    await using actor = createReplyRecoveryActorFixture({
      agentId: "main",
      storePath,
      sessionKey,
      getSessionId: () => sessionId,
    });
    const controller = createReplyRestartRecoveryClaimController({
      agentId: "main",
      acquireSessionActor: () => actor.acquireSessionActor(),
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      admissionRunId: "recovery-run",
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => restartAborted,
      resolveDeliveryContext: () => undefined,
      sessionKey,
      setEntry: (next) => {
        entry = next;
      },
      storePath,
    });

    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    restartAborted = true;
    await controller.clear();

    const persisted = loadSessionEntry({ storePath, sessionKey });
    expect(persisted).toMatchObject({
      lifecycleRunId: "recovery-run",
      restartRecoveryDeliveryRunId: "recovery-run",
    });
    expect(persisted?.status).toBeUndefined();
  });

  it.each([
    "restart-handoff",
    "restart-abort",
    "successor-generation",
    "missing-generation",
    "commit-rotation",
    "commit-abort",
    "session-retarget",
  ] as const)(
    "preserves the delivery claim when queued cleanup loses ownership through %s",
    async (interruption) => {
      const root = tempDirs.make("openclaw-reply-claim-queued-cleanup-");
      const scope = { storePath: path.join(root, "sessions.json"), sessionKey: "agent:main:main" };
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const deliveryContext = { channel: "telegram", to: "chat", accountId: "default" };
      let restartAborted = false;
      let sessionId = "session";
      let entry: InternalSessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        status: undefined,
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "source-turn",
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoverySourceIngress: "channel",
      };
      await replaceSessionEntry(scope, entry);
      await using actor = createReplyRecoveryActorFixture({
        agentId: "main",
        ...scope,
        getSessionId: () => sessionId,
      });
      const controller = createReplyRestartRecoveryClaimController({
        agentId: "main",
        acquireSessionActor: () => actor.acquireSessionActor(),
        lifecycleGeneration:
          interruption === "missing-generation" ? undefined : lifecycleGeneration,
        admissionRunId: "recovery-run",
        getEntry: () => entry,
        getSessionId: () => sessionId,
        isRestartAbort: () => restartAborted,
        resolveDeliveryContext: () => deliveryContext,
        setEntry: (next) => {
          entry = next;
        },
        ...scope,
      });
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");

      const writerEntered = createDeferred();
      const releaseWriter = createDeferred();
      let successorGeneration: string | undefined;
      const handoff = updateSessionEntry(scope, async (current) => {
        writerEntered.resolve();
        await releaseWriter.promise;
        if (interruption === "restart-handoff" || interruption === "successor-generation") {
          transitionMainSessionRecovery(current, {
            kind: "mark_interrupted",
            cycleId: "restart-cycle",
            now: 2,
            runs: [{ runId: "original-run", lifecycleGeneration }],
          });
          if (successorGeneration) {
            const recovery = current.mainRestartRecovery!;
            transitionMainSessionRecovery(current, {
              kind: "prepare_attempt",
              attempt: 1,
              lifecycleGeneration: successorGeneration,
              now: 3,
              observation: {
                sessionId: current.sessionId,
                cycleId: recovery.cycleId,
                revision: recovery.revision,
              },
              runId: "recovery-run",
              executionIdentity: { state: "disabled" },
            });
            transitionMainSessionRecovery(current, {
              kind: "admit_recovery",
              lifecycleGeneration: successorGeneration,
              now: 4,
              runId: "recovery-run",
              sessionId: current.sessionId,
            });
          }
        }
        return current;
      });
      await writerEntered.promise;
      let interruptedAtCommit = false;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, options) =>
          createAdmission((request, grant) => {
            if (
              !interruptedAtCommit &&
              (interruption === "commit-rotation" || interruption === "commit-abort") &&
              request.stage === "transaction" &&
              isRecord(request.facts) &&
              isRecord(request.facts.publication) &&
              request.facts.publication.kind === "session-entry-patch-validated"
            ) {
              interruptedAtCommit = true;
              if (interruption === "commit-rotation") {
                rotateAgentEventLifecycleGeneration();
              } else {
                restartAborted = true;
              }
            }
            admit(request, grant);
          }, options),
        );
      // The old cleanup enters before shutdown; its actual write waits behind the handoff.
      const clearing = controller.clear().catch((error: unknown) => {
        expect(
          interruption === "session-retarget"
            ? isRestartRecoveryClaimChangedError(error)
            : isAgentRunStaleLifecycleError(error),
        ).toBe(true);
      });
      try {
        if (interruption === "restart-abort") {
          restartAborted = true;
        } else if (interruption === "successor-generation") {
          successorGeneration = rotateAgentEventLifecycleGeneration();
        } else if (interruption === "session-retarget") {
          sessionId = "successor-session";
        }
      } finally {
        releaseWriter.resolve();
      }
      try {
        await Promise.all([handoff, clearing]);
      } finally {
        admission.mockRestore();
      }
      expect(interruptedAtCommit).toBe(
        interruption === "commit-rotation" || interruption === "commit-abort",
      );

      const persisted = loadSessionEntry(scope);
      expect(persisted).toMatchObject({
        abortedLastRun: interruption === "restart-handoff",
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "source-turn",
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoverySourceIngress: "channel",
      });
      expect(persisted?.status).toBe(
        interruption === "restart-handoff" ? "interrupted" : undefined,
      );
      expect(persisted?.restartRecoveryTerminalRunIds).toBeUndefined();
      if (successorGeneration) {
        expect(persisted?.restartRecoveryRuns).toContainEqual({
          runId: "recovery-run",
          lifecycleGeneration: successorGeneration,
        });
      }
    },
  );

  it("retires the source claim after an ordinary user abort", async () => {
    const root = tempDirs.make("openclaw-reply-claim-user-abort-");
    const scope = { storePath: path.join(root, "sessions.json"), sessionKey: "agent:main:main" };
    let entry: InternalSessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      status: undefined,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryContext: { channel: "telegram", to: "chat" },
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry(scope, entry);
    await using actor = createReplyRecoveryActorFixture({
      agentId: "main",
      ...scope,
      getSessionId: () => "session",
    });
    const controller = createReplyRestartRecoveryClaimController({
      agentId: "main",
      acquireSessionActor: () => actor.acquireSessionActor(),
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      admissionRunId: "recovery-run",
      getEntry: () => entry,
      getSessionId: () => "session",
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      setEntry: (next) => {
        entry = next;
      },
      ...scope,
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    await markSessionAbortTarget({ scope });
    await controller.clear();

    const persisted = loadSessionEntry(scope);
    expect(persisted?.abortedLastRun).toBe(true);
    expect(persisted?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(persisted?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(persisted?.restartRecoveryTerminalRunIds).toContain("source-turn");
  });
});
