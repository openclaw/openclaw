import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { createHarnessCompletionSourceAssertion } from "../../agents/agent-harness-completion-recovery.js";
import { claimAgentSessionWriter } from "../../agents/embedded-agent-runner/run/session-bootstrap.js";
import { renderStorageFailureSummary } from "../../agents/failover/assistant-request-failure-copy.js";
import { createOperatorRecoveryAuthority } from "../../agents/operator-recovery.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { HarnessCompletionRecovery } from "../../config/sessions/restart-recovery-types.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRecoveryControllerFixture } from "./recovery-controller.fixture.test-support.js";

function recoveryScope(sessionsDir: string, name: string) {
  return {
    agentId: "main",
    storePath: path.join(sessionsDir, "sessions.json"),
    sessionKey: "agent:main:dashboard:" + name,
  };
}
async function reopen(scope: ReturnType<typeof recoveryScope>, root: string) {
  await closeOpenClawAgentDatabasesAsync(root);
  closeOpenClawAgentDatabasesForTest(root);
  return expectDefined(
    loadSessionEntry({ ...scope, readConsistency: "latest" }),
    "session survives reopen",
  );
}

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

it.each(["new input", "accepted input"] as const)(
  "keeps %s admission durable across restart and settles the backend runtime",
  (admission) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const scope = recoveryScope(state.sessionsDir(), "durable-admission");
      const executionRunId = "admitted-execution";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const entry: InternalSessionEntry = {
        sessionId: "admitted-session",
        updatedAt: 1,
        startedAt: 1,
        ...(admission === "accepted input"
          ? {
              lifecycleRunId: executionRunId,
              restartRecoveryDeliveryRunId: "admitted-input",
              restartRecoveryDeliverySourceRunId: "admitted-input",
              restartRecoverySourceIngress: "control-ui",
              restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
            }
          : { endedAt: 2, runtimeMs: 1, status: "done", lastRunId: "previous-run" }),
      };
      const fixture = await createRecoveryControllerFixture(scope, entry);
      {
        const recorder =
          admission === "new input"
            ? createUserTurnTranscriptRecorder({
                message: { role: "user", content: "continue the task", timestamp: 3 },
                target: { ...scope, sessionId: entry.sessionId, sessionEntry: entry },
                updateMode: "none",
              })
            : undefined;
        await using actor = fixture;
        const controller = actor.controller({
          admissionRunId: "admitted-input",
          executionRunId,
          lifecycleGeneration,
        });
        await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
      }
      const admitted = await reopen(scope, state.root);
      expect(admitted.lifecycleRunId).toBe(executionRunId);
      expect(admitted.status).toBeUndefined();
      expect(admitted.endedAt).toBeUndefined();
      expect(admitted.runtimeMs).toBeUndefined();
      expect(admitted.lastRunId).toBeUndefined();
      expect(admitted.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
      expect(admitted.restartRecoveryRuns).toEqual([
        { runId: executionRunId, lifecycleGeneration },
      ]);
      if (admission === "accepted input") {
        expect(admitted.updatedAt).toBe(1);
      } else {
        expect(admitted.updatedAt).toBeGreaterThan(1);
      }

      const startedAt = expectDefined(admitted.startedAt, "admission records a start time") + 10;
      const event = { runId: executionRunId, lifecycleGeneration, sessionId: entry.sessionId };
      await persistGatewaySessionLifecycleEvent({
        ...scope,
        event: { ...event, ts: startedAt, data: { phase: "start", startedAt } },
      });
      expect(loadSessionEntry(scope)?.startedAt).toBe(admitted.startedAt);
      await persistGatewaySessionLifecycleEvent({
        ...scope,
        event: {
          ...event,
          ts: startedAt + 20,
          data: { phase: "end", startedAt, endedAt: startedAt + 20 },
        },
      });
      const settled = await reopen(scope, state.root);
      expect(settled).toMatchObject({
        status: "done",
        startedAt,
        endedAt: startedAt + 20,
        runtimeMs: 20,
        lastRunId: executionRunId,
      });
      expect(settled.lifecycleRunId).toBeUndefined();
      expect(settled.restartRecoveryRuns).toBeUndefined();
    }),
);

it.each([true, false])("keeps scheduled recovery bookkeeping quiet (scheduled=%s)", (scheduled) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = recoveryScope(state.sessionsDir(), "quiet-recovery");
    const entry: InternalSessionEntry = { sessionId: "quiet-session", updatedAt: 1 };
    let observed: number[];
    {
      await using fixture = await createRecoveryControllerFixture(scope, entry);
      const controller = fixture.controller({
        admissionRunId: "quiet-recovery-run",
        operatorAuthority: createOperatorRecoveryAuthority("test-operator", "test-grant"),
        requesterOrigin: { sessionKey: scope.sessionKey, operatorProfileId: "test-operator" },
        inputProvenance: scheduled
          ? { kind: "internal_system", sourceTool: "cron_execution" }
          : { kind: "external_user" },
      });
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");
      const admitted = expectDefined(loadSessionEntry(scope), "recovery admitted");
      expect(admitted.restartRecoveryDeliveryRunId).toBe("quiet-recovery-run");
      expect(Boolean(admitted.restartRecoveryOperatorSource)).toBe(!scheduled);
      expect(admitted.startedAt).toBeGreaterThan(1);
      await controller.beginBeforeAgentReply();
      const pending = expectDefined(loadSessionEntry(scope), "hook pending");
      expect(pending.restartRecoveryBeforeAgentReplyState).toBe("pending");
      await controller.checkpointBeforeAgentReply({
        state: "handled-reply",
        pendingFinalDelivery: {
          intentId: "quiet-intent",
          text: "Review is ready.",
          deliveries: [{ id: "quiet-delivery", state: "prepared" }],
        },
      });
      const checkpoint = expectDefined(loadSessionEntry(scope), "hook checkpoint persisted");
      expect(checkpoint.restartRecoveryBeforeAgentReplyState).toBe("handled-reply");
      expect(checkpoint.pendingFinalDelivery).toMatchObject({
        intentId: "quiet-intent",
        text: "Review is ready.",
        createdAt: expect.any(Number),
      });
      expect(checkpoint.pendingFinalDelivery?.createdAt).toBeGreaterThan(1);
      observed = [admitted.updatedAt, pending.updatedAt, checkpoint.updatedAt];
    }
    const persisted = await reopen(scope, state.root);
    expect(persisted.restartRecoveryDeliveryRunId).toBe("quiet-recovery-run");
    expect(persisted.pendingFinalDelivery?.intentId).toBe("quiet-intent");
    if (scheduled) {
      expect([...observed, persisted.updatedAt]).toEqual([1, 1, 1, 1]);
    } else {
      expect(observed.every((timestamp) => timestamp > 1)).toBe(true);
      expect(persisted.updatedAt).toBe(observed.at(-1));
    }
  }),
);

it.each([
  { sourceTool: "sessions_send", kind: "inter_session", runId: "peer-run" },
  { sourceTool: "subagent_announce", kind: "inter_session", runId: "announce:child-run" },
  {
    sourceTool: "subagent_settle",
    kind: "inter_session",
    runId: "announce:requester-settle:main:parent:child:yield-1",
  },
  {
    sourceTool: "session_goal_continue",
    kind: "internal_system",
    runId: "goal:peer-session:goal-1:announce:requester-settle:main:parent:child:yield-1",
  },
] as const)("retains the operator source for an authenticated $sourceTool continuation", (input) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = recoveryScope(state.sessionsDir(), "peer-target");
    const entry: InternalSessionEntry = { sessionId: "peer-session", updatedAt: 1 };
    await using actor = await createRecoveryControllerFixture(scope, entry);
    const operatorAuthority = createOperatorRecoveryAuthority("peer-operator", "peer-grant");

    const controller = actor.controller({
      admissionRunId: input.runId,
      executionRunId: "continuation-execution",
      operatorAuthority,
      requesterOrigin: {
        sessionKey: "agent:main:dashboard:peer-source",
        operatorProfileId: "peer-operator",
      },
      sourceReplyDeliveryMode: "message_tool_only",
      inputProvenance: {
        kind: input.kind,
        sourceTool: input.sourceTool,
        ...(input.kind === "inter_session"
          ? { sourceSessionKey: "agent:main:dashboard:peer-source", sourceChannel: "internal" }
          : {}),
      },
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    expect(loadSessionEntry(scope)).toMatchObject({
      restartRecoveryDeliverySourceRunId: input.runId,
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
      restartRecoveryOperatorSource: {
        sessionKey: scope.sessionKey,
        sourceRunId: input.runId,
        snapshot: { profileId: "peer-operator", sourceIngress: "control-ui" },
      },
    });
  }),
);
it.each([
  "execute",
  "cancel",
  "restart",
  "unknown",
  "rollback",
  "admission-rejected",
  "source-replaced",
] as const)("retains accepted input custody until capacity admission (%s)", async (outcome) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = recoveryScope(state.sessionsDir(), "capacity-admission");
    const acceptedInput = {
      lifecycleRunId: "accepted-input",
      activeWriterRunId: "previous-writer",
      restartRecoveryDeliveryRunId: "accepted-input",
      restartRecoveryDeliverySourceRunId: "accepted-input",
      restartRecoverySourceIngress: "control-ui" as const,
      restartRecoveryDeliveryRequestFingerprint: "accepted-fingerprint",
    };
    const entry: InternalSessionEntry = {
      ...acceptedInput,
      sessionId: "capacity-session",
      lifecycleRevision: "capacity-revision",
      updatedAt: 1,
    };
    const completion: HarnessCompletionRecovery | undefined =
      outcome === "execute" || outcome === "source-replaced"
        ? {
            taskId: "completion-task",
            taskRunId: "completion-task-run",
            taskStatus: "succeeded",
            sourceRunId: "accepted-input",
            requesterSessionKey: scope.sessionKey,
            requesterAgentId: scope.agentId,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
          }
        : undefined;
    entry.restartRecoveryHarnessCompletion = completion;
    const actorFixture = await createRecoveryControllerFixture(scope, entry);
    let activityAt = entry.updatedAt;
    {
      await using fixture = actorFixture;
      const { operation, operationAdmission } = await fixture.bind();
      const controller = fixture.controller({
        operationAdmission,
        isRestartAbort: () => outcome === "restart",
        admissionRunId: "accepted-input",
        executionRunId: "capacity-execution",
      });
      const sourceAdmission =
        completion &&
        prepareSystemAgentRunAdmission(
          {},
          "capacity-execution",
          "main",
          "writer-test",
          createHarnessCompletionSourceAssertion({ claim: completion, storePath: scope.storePath }),
        );
      try {
        const admittedRunContext = await sourceAdmission?.admit("embedded");
        await expect(controller.admitUserTurn()).resolves.toBe("admitted");
        expect(loadSessionEntry(scope)).toMatchObject(acceptedInput);
        const claimWriter = () =>
          claimAgentSessionWriter({
            ...scope,
            sessionId: entry.sessionId,
            sessionTarget: { ...scope, sessionId: entry.sessionId },
            replyOperation: operation,
            admittedRunContext,
            runId: "capacity-execution",
            prompt: "Synthetic queued input",
            timeoutMs: 30_000,
            workspaceDir: state.workspaceDir,
          });
        const patchEntry = (patch: Partial<InternalSessionEntry>, preserveActivity = false) =>
          applySessionEntryOperation(
            scope,
            {
              kind: "fields",
              expected: { sessionId: entry.sessionId },
              patch,
            },
            { skipMaintenance: true, preserveActivity },
          );
        if (outcome === "execute") {
          const interleaved = expectDefined(
            await patchEntry({ label: "updated while waiting" }),
            "activity recorded while waiting",
          );
          activityAt = interleaved.updatedAt;
          expect(activityAt).toBeGreaterThan(1);
          await expect(claimWriter()).resolves.toMatchObject({
            expectedWriterRunId: "capacity-execution",
            entry: {
              lifecycleRunId: "capacity-execution",
              activeWriterRunId: "capacity-execution",
              label: "updated while waiting",
              updatedAt: activityAt,
            },
          });
        } else if (outcome === "source-replaced" && completion) {
          await patchEntry(
            {
              restartRecoveryHarnessCompletion: { ...completion, taskId: "replacement-task" },
            },
            true,
          );
          await expect(claimWriter()).rejects.toThrow();
        } else if (outcome === "admission-rejected") {
          const { actor } = expectDefined(await fixture.acquireSessionActor(), "admitted actor");
          using adoptionAttempt = vi.spyOn(actor, "adoptRun");
          await actor.release();
          await expect(claimWriter()).rejects.toThrow();
          await expect(claimWriter()).rejects.toThrow();
          await controller.clear();
          expect(adoptionAttempt).toHaveBeenCalledOnce();
        } else if (outcome === "unknown" || outcome === "rollback") {
          const { actor } = expectDefined(await fixture.acquireSessionActor(), "admitted actor");
          const adopt = actor.adoptRun.bind(actor);
          using adoptionAttempt = vi
            .spyOn(actor, "adoptRun")
            .mockImplementation(async (input, authority, observer) => {
              if (outcome === "rollback") {
                const result = await adopt(
                  input,
                  {
                    ...authority,
                    authorize(stage, facts) {
                      authority.authorize?.(stage, facts);
                      if (stage === "commit") {
                        throw new Error("Canceled before adoption commit");
                      }
                    },
                  },
                  observer,
                );
                expect(result.kind).toBe("rolled-back");
                return result;
              }
              // Commit through the real owner, then lose the receipt before the producer sees it.
              const result = await adopt(input, authority);
              if (result.kind !== "committed") {
                return result;
              }
              return {
                kind: "unknown",
                target: actor.target,
                commandId: input.commandId,
                error: {
                  name: "Error",
                  message: "Adoption receipt lost",
                  cause: new Error("Worker response lost", {
                    cause: Object.assign(new Error("database or disk is full"), {
                      code: "SQLITE_FULL",
                    }),
                  }),
                },
              };
            });
          const error =
            outcome === "rollback" ? "Canceled before adoption commit" : "Adoption receipt lost";
          const failure = await claimWriter().catch((caughtError: unknown) => caughtError);
          expect(failure).toHaveProperty("message", error);
          if (outcome === "unknown") {
            expect(failure).toHaveProperty("code", "outcome-unknown");
            const storageOutcome = classifyGatewayStorageFailure(failure);
            expect(storageOutcome).toBe("session_actor_reconciliation");
            expect(renderStorageFailureSummary(storageOutcome)).toMatch(
              /check.*history.*before trying again/i,
            );
          }
          await expect(claimWriter()).rejects.toThrow(error);
          await controller.clear();
          expect(adoptionAttempt).toHaveBeenCalledOnce();
        } else {
          await controller.clear();
        }
      } finally {
        sourceAdmission?.close();
      }
    }
    const persisted = await reopen(scope, state.root);
    if (outcome === "execute" || outcome === "unknown") {
      expect(persisted).toMatchObject({
        lifecycleRunId: "capacity-execution",
        activeWriterRunId: "capacity-execution",
        restartRecoveryDeliveryRunId: "accepted-input",
        restartRecoveryDeliverySourceRunId: "accepted-input",
        updatedAt: activityAt,
      });
      if (outcome === "execute") {
        expect(persisted.label).toBe("updated while waiting");
      }
      expect(persisted.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
    } else if (outcome === "cancel" || outcome === "rollback" || outcome === "admission-rejected") {
      expect(persisted.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(persisted.activeWriterRunId).toBe("previous-writer");
    } else {
      expect(persisted).toMatchObject(acceptedInput);
    }
  });
});
