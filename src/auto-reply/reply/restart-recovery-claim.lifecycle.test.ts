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
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
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
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import { clearOpenClawAgentDatabaseValidationCache } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleReplyAgentRunError } from "./agent-runner-core.js";
import { createRecoveryControllerFixture } from "./recovery-controller.fixture.test-support.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => memorySessionActorOwners.reset());

async function claimFixture(
  initial: Partial<InternalSessionEntry> = {},
  overrides: Partial<Parameters<typeof createReplyRestartRecoveryClaimController>[0]> = {},
) {
  const scope = {
    agentId: "main",
    storePath: path.join(tempDirs.make("openclaw-reply-claim-"), "sessions.json"),
    sessionKey: "agent:main:main",
  };
  const fixture = await createRecoveryControllerFixture(
    scope,
    {
      sessionId: "session",
      updatedAt: 1,
      status: undefined,
      restartRecoveryDeliveryRunId: "recovery-run",
      ...initial,
    },
    { admissionRunId: "recovery-run", ...overrides },
  );
  return { ...fixture, controller: fixture.controller() };
}

async function restartReply(
  controller: ReturnType<typeof createReplyRestartRecoveryClaimController>,
  operation: ReplyOperation,
) {
  let drains = 0;
  const reply = await handleReplyAgentRunError(new Error("Backend stopped"), {
    resolveVisibleReplyDelivery: async () => false,
    isHeartbeat: false,
    replyExpectation: "required",
    isRestartRecoveryArmed: controller.isArmed,
    replyOperation: operation,
    resolvedVerboseLevel: "off",
    sessionCtx: {},
    returnWithQueuedFollowupDrain: (value) => {
      drains += 1;
      return value;
    },
  });
  expect(drains).toBe(1);
  return reply;
}

async function withTrackedReply(
  test: (fixture: {
    controller: ReturnType<typeof createReplyRestartRecoveryClaimController>;
    operation: ReplyOperation;
    confirmArmed: () => Promise<void>;
    replaceWithSuccessor: () => Promise<void>;
    releaseDatabase: () => Promise<void>;
    databasePath: string;
    readEntry: () => ReturnType<typeof loadSessionEntry>;
  }) => Promise<void>,
  storage: "durable" | "memory" = "durable",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey:
        storage === "memory"
          ? "agent:main:dashboard:incognito-recovery"
          : "agent:main:retired-readiness",
      storePath:
        storage === "memory"
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
          : state.statePath("sessions.json"),
    };
    await using actor = await createRecoveryControllerFixture(scope, {
      sessionId: "old-session",
      updatedAt: 1,
      status: undefined,
      restartRecoveryDeliveryRunId: "old-recovery",
      ...(storage === "memory" ? { incognito: true } : {}),
    });
    const memory =
      storage === "memory"
        ? memorySessionActorOwners.read({ agentId: scope.agentId, path: scope.storePath })
        : undefined;
    const operation = createReplyOperation({
      ...scope,
      sessionId: actor.entry.sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    const controller = actor.controller(
      {
        admissionRunId: "old-recovery",
        lifecycleGeneration: operation.lifecycleGeneration,
        getSessionId: () => operation.sessionId,
        isRestartAbort: () =>
          operation.result?.kind === "aborted" && operation.result.code === "aborted_for_restart",
      },
      operation,
    );
    try {
      await controller.admitUserTurn();
      await test({
        controller,
        operation,
        async confirmArmed() {
          actor.setEntry({ ...actor.entry, abortedLastRun: true });
          await replaceSessionEntry(scope, actor.entry);
          expect(await controller.isArmed()).toBe(true);
        },
        async replaceWithSuccessor() {
          actor.setEntry({
            sessionId: "successor-session",
            updatedAt: 2,
            status: undefined,
            abortedLastRun: true,
            restartRecoveryDeliveryRunId: "successor-recovery",
          });
          await replaceSessionEntry(scope, actor.entry);
        },
        readEntry: () => loadSessionEntry(scope),
        releaseDatabase: () => actor.release(),
        databasePath: resolveSqliteTargetFromSessionStorePath(scope.storePath, {
          agentId: scope.agentId,
          env: state.env,
        }).path,
      });
      if (storage === "memory") {
        expect(memory).toBeDefined();
        expect(
          memorySessionActorOwners.read({ agentId: scope.agentId, path: scope.storePath }),
        ).toBe(memory);
        expect(getOpenClawAgentDatabaseIfOpen({ ...scope, path: scope.storePath })).toBeUndefined();
        expect(fs.existsSync(scope.storePath)).toBe(false);
      }
    } finally {
      operation.complete();
    }
  });
}

it("settles incognito recovery through hook checkpoints and restart readiness", async () => {
  await withTrackedReply(async ({ controller, operation, confirmArmed, readEntry }) => {
    await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
    await controller.checkpointBeforeAgentReply({ state: "handled-silent" });
    expect(readEntry()?.restartRecoveryBeforeAgentReplyState).toBe("handled-silent");
    await confirmArmed();
    operation.abortForRestart();
    const reply = await restartReply(controller, operation);
    expect(reply).toEqual({});
    expect(readEntry()).toMatchObject({
      sessionId: "old-session",
      restartRecoveryDeliveryRunId: "old-recovery",
      abortedLastRun: true,
    });
  }, "memory");
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
    await withTrackedReply(async (fixture) => {
      const { controller, operation, readEntry } = fixture;
      if (confirmed) {
        await fixture.confirmArmed();
      }
      let restore: (() => void) | undefined;
      let assertBoundary: () => void;
      try {
        if (stage === "cold-registration") {
          await fixture.releaseDatabase();
          await closeOpenClawAgentDatabasesAsync();
          clearOpenClawAgentDatabaseValidationCache();
          revokeSqliteDatabaseAdmissionsForPath(fixture.databasePath);
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
            await fixture.replaceWithSuccessor();
          } else {
            reads.mockImplementationOnce(async (...args) => {
              const result = await read(...args);
              if (stage === "during-read") {
                rotateAgentEventLifecycleGeneration();
              }
              await fixture.replaceWithSuccessor();
              return result;
            });
          }
        }
        const reply = await restartReply(controller, operation);
        expect(reply?.text).toBe(
          confirmed
            ? undefined
            : "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
        );
        assertBoundary();
      } finally {
        restore?.();
      }
    });
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
  it.each(["done", "failed", "restart"] as const)(
    "settles lifecycle ownership for %s cleanup",
    async (outcome) => {
      let restartAborted = false;
      await using fixture = await claimFixture(
        { abortedLastRun: false, lifecycleRunId: "recovery-run", startedAt: 1 },
        { isRestartAbort: () => restartAborted },
      );
      const { controller, scope } = fixture;
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");
      if (outcome === "failed") {
        fixture.setEntry(
          (await updateSessionEntry(scope, () => ({
            restartRecoveryDeliveryReceiptState: "terminal-pending",
          }))) as InternalSessionEntry,
        );
      } else if (outcome === "done") {
        await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
        await controller.checkpointBeforeAgentReply({ state: "handled-silent" });
      } else {
        restartAborted = true;
      }
      await controller.clear();
      const persisted = loadSessionEntry(scope);
      expect(persisted?.status).toBe(outcome === "restart" ? undefined : outcome);
      expect(persisted?.lifecycleRunId).toBe(outcome === "restart" ? "recovery-run" : undefined);
      if (outcome === "restart") {
        expect(persisted?.restartRecoveryDeliveryRunId).toBe("recovery-run");
      }
    },
  );

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
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const deliveryContext = { channel: "telegram", to: "chat", accountId: "default" };
      let restartAborted = false;
      let sessionId = "session";
      await using fixture = await claimFixture(
        {
          abortedLastRun: false,
          restartRecoveryDeliverySourceRunId: "source-turn",
          restartRecoveryDeliveryContext: deliveryContext,
          restartRecoverySourceIngress: "channel",
        },
        {
          lifecycleGeneration:
            interruption === "missing-generation" ? undefined : lifecycleGeneration,
          getSessionId: () => sessionId,
          isRestartAbort: () => restartAborted,
          resolveDeliveryContext: () => deliveryContext,
        },
      );
      const { controller, scope } = fixture;
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
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
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
      });
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
    await using fixture = await claimFixture({
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryContext: { channel: "telegram", to: "chat" },
      restartRecoverySourceIngress: "channel",
    });
    const { controller, scope } = fixture;
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
