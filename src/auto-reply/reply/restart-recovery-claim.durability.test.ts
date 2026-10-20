import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createHarnessCompletionSourceAssertion } from "../../agents/agent-harness-completion-recovery.js";
import { claimAgentSessionWriter } from "../../agents/embedded-agent-runner/run/session-bootstrap.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { HarnessCompletionRecovery } from "../../config/sessions/restart-recovery-types.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

it.each(["new input", "accepted input"] as const)(
  "keeps %s admission durable across restart and settles the backend runtime",
  (admission) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const scope = {
        agentId: "main",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionKey: "agent:main:dashboard:durable-admission",
      };
      const executionRunId = "admitted-execution";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      let entry: InternalSessionEntry = {
        sessionId: "admitted-session",
        updatedAt: 1,
        startedAt: 1,
        endedAt: 2,
        runtimeMs: 1,
        status: "done",
        lastRunId: "previous-run",
        ...(admission === "accepted input"
          ? {
              status: undefined,
              endedAt: undefined,
              runtimeMs: undefined,
              lastRunId: undefined,
              lifecycleRunId: executionRunId,
              restartRecoveryDeliveryRunId: "admitted-input",
              restartRecoveryDeliverySourceRunId: "admitted-input",
              restartRecoverySourceIngress: "control-ui",
              restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
            }
          : {}),
      };
      await replaceSessionEntry(scope, entry);
      {
        const recorder =
          admission === "new input"
            ? createUserTurnTranscriptRecorder({
                message: { role: "user", content: "continue the task", timestamp: 3 },
                target: { ...scope, sessionId: entry.sessionId, sessionEntry: entry },
                updateMode: "none",
              })
            : undefined;
        await using actor = createReplyRecoveryActorFixture({
          ...scope,
          getSessionId: () => entry.sessionId,
        });
        const controller = createReplyRestartRecoveryClaimController({
          acquireSessionActor: () => actor.acquireSessionActor(),
          isRestartAbort: () => false,
          resolveDeliveryContext: () => undefined,
          ...scope,
          admissionRunId: "admitted-input",
          executionRunId,
          lifecycleGeneration,
          getEntry: () => entry,
          getSessionId: () => entry.sessionId,
          setEntry: (next) => {
            entry = next;
          },
        });
        await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
      }
      await closeOpenClawAgentDatabasesAsync(state.root);
      closeOpenClawAgentDatabasesForTest(state.root);
      const admitted = expectDefined(
        loadSessionEntry({ ...scope, readConsistency: "latest" }),
        "admitted session survives restart",
      );
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
      await closeOpenClawAgentDatabasesAsync(state.root);
      closeOpenClawAgentDatabasesForTest(state.root);
      const settled = expectDefined(
        loadSessionEntry({ ...scope, readConsistency: "latest" }),
        "settled session survives restart",
      );
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

it("keeps an authenticated peer follow-up internal while retaining its operator source", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:dashboard:peer-target",
    };
    let entry: InternalSessionEntry = { sessionId: "peer-session", updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "peer-operator",
      scopes: ["operator.read"],
      assertCurrent() {},
      recoverySnapshot: {
        profileId: "peer-operator",
        scopes: ["operator.read"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "peer-grant",
          role: "operator",
          authMethod: "token",
        },
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "control-ui",
      },
    });

    await using actor = createReplyRecoveryActorFixture({
      ...scope,
      getSessionId: () => entry.sessionId,
    });
    const controller = createReplyRestartRecoveryClaimController({
      ...scope,
      admissionRunId: "peer-run",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      getEntry: () => entry,
      getSessionId: () => entry.sessionId,
      setEntry: (next) => {
        entry = next;
      },
      acquireSessionActor: () => actor.acquireSessionActor(),
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      operatorAuthority,
      requesterOrigin: {
        sessionKey: "agent:main:dashboard:peer-source",
        operatorProfileId: "peer-operator",
      },
      sourceReplyDeliveryMode: "message_tool_only",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: "agent:main:dashboard:peer-source",
        sourceChannel: "webchat",
      },
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    expect(loadSessionEntry(scope)).toMatchObject({
      restartRecoveryDeliverySourceRunId: "peer-run",
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
      restartRecoveryOperatorSource: {
        sessionKey: scope.sessionKey,
        sourceRunId: "peer-run",
        snapshot: { profileId: "peer-operator", sourceIngress: "control-ui" },
      },
    });
  }));
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
    const scope = {
      agentId: "main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:dashboard:capacity-admission",
    };
    let entry: InternalSessionEntry = {
      sessionId: "capacity-session",
      lifecycleRevision: "capacity-revision",
      updatedAt: 1,
      lifecycleRunId: "accepted-input",
      activeWriterRunId: "previous-writer",
      restartRecoveryDeliveryRunId: "accepted-input",
      restartRecoveryDeliverySourceRunId: "accepted-input",
      restartRecoverySourceIngress: "control-ui",
      restartRecoveryDeliveryRequestFingerprint: "accepted-fingerprint",
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
    await replaceSessionEntry(scope, entry);
    let activityAt = entry.updatedAt;
    {
      await using fixture = createReplyRecoveryActorFixture({
        ...scope,
        getSessionId: () => entry.sessionId,
      });
      const { operation, operationAdmission } = await fixture.bind();
      const controller = createReplyRestartRecoveryClaimController({
        ...scope,
        operationAdmission,
        acquireSessionActor: () => fixture.acquireSessionActor(),
        isRestartAbort: () => outcome === "restart",
        resolveDeliveryContext: () => undefined,
        admissionRunId: "accepted-input",
        executionRunId: "capacity-execution",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        getEntry: () => entry,
        getSessionId: () => entry.sessionId,
        setEntry: (next) => {
          entry = next;
        },
      });
      await waitForDiagnosticEventsDrained();
      const writes: string[] = [];
      const unsubscribe = onInternalDiagnosticEvent(
        (event) => {
          if (
            event.type === "worker.request" &&
            event.phase === "completed" &&
            (event.requestClass === "session.actor.adoptRun" ||
              event.requestClass === "session.entry.patch.commit")
          ) {
            writes.push(event.requestClass);
          }
        },
        { include: ["worker.request"] },
      );
      const sourceAdmission =
        completion &&
        prepareSystemAgentRunAdmission(
          {},
          "capacity-execution",
          "main",
          "writer-test",
          createHarnessCompletionSourceAssertion({
            claim: completion,
            storePath: scope.storePath,
          }),
        );
      try {
        const admittedRunContext = await sourceAdmission?.admit("embedded");
        await expect(controller.admitUserTurn()).resolves.toBe("admitted");
        await waitForDiagnosticEventsDrained();
        expect(writes).toEqual([]);
        expect(loadSessionEntry(scope)).toMatchObject({
          lifecycleRunId: "accepted-input",
          activeWriterRunId: "previous-writer",
          restartRecoveryDeliveryRequestFingerprint: "accepted-fingerprint",
        });
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
        if (outcome === "execute") {
          const interleaved = expectDefined(
            await applySessionEntryOperation(
              scope,
              {
                kind: "fields",
                expected: { sessionId: entry.sessionId },
                patch: { label: "updated while waiting" },
              },
              { skipMaintenance: true },
            ),
            "activity recorded while waiting",
          );
          activityAt = interleaved.updatedAt;
          expect(activityAt).toBeGreaterThan(1);
          await waitForDiagnosticEventsDrained();
          writes.length = 0;
          await expect(claimWriter()).resolves.toMatchObject({
            expectedWriterRunId: "capacity-execution",
            entry: {
              lifecycleRunId: "capacity-execution",
              activeWriterRunId: "capacity-execution",
              label: "updated while waiting",
              updatedAt: activityAt,
            },
          });
          await waitForDiagnosticEventsDrained();
          expect(writes).toEqual(["session.actor.adoptRun"]);
        } else if (outcome === "source-replaced" && completion) {
          await applySessionEntryOperation(
            scope,
            {
              kind: "fields",
              expected: { sessionId: entry.sessionId },
              patch: {
                restartRecoveryHarnessCompletion: { ...completion, taskId: "replacement-task" },
              },
            },
            { skipMaintenance: true, preserveActivity: true },
          );
          await waitForDiagnosticEventsDrained();
          writes.length = 0;
          await expect(claimWriter()).rejects.toThrow();
          await waitForDiagnosticEventsDrained();
          expect(writes).toEqual([]);
        } else if (outcome === "admission-rejected") {
          const { actor } = expectDefined(await fixture.acquireSessionActor(), "admitted actor");
          using adoptionAttempt = vi.spyOn(actor, "adoptRun");
          await actor.release();
          await expect(claimWriter()).rejects.toThrow();
          await expect(claimWriter()).rejects.toThrow();
          await controller.clear();
          await waitForDiagnosticEventsDrained();
          expect(adoptionAttempt).toHaveBeenCalledOnce();
          expect(writes).toEqual(["session.entry.patch.commit"]);
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
                error: { name: "Error", message: "Adoption receipt lost" },
              };
            });
          const error =
            outcome === "rollback" ? "Canceled before adoption commit" : "Adoption receipt lost";
          await expect(claimWriter()).rejects.toThrow(error);
          await expect(claimWriter()).rejects.toThrow(error);
          await controller.clear();
          await waitForDiagnosticEventsDrained();
          expect(adoptionAttempt).toHaveBeenCalledOnce();
          expect(writes).toEqual(
            outcome === "rollback"
              ? ["session.actor.adoptRun", "session.entry.patch.commit"]
              : ["session.actor.adoptRun"],
          );
        } else {
          await controller.clear();
        }
      } finally {
        sourceAdmission?.close();
        unsubscribe();
      }
    }
    await closeOpenClawAgentDatabasesAsync(state.root);
    closeOpenClawAgentDatabasesForTest(state.root);
    const persisted = expectDefined(loadSessionEntry(scope), "queued input survives reopen");
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
      expect(persisted).toMatchObject({
        lifecycleRunId: "accepted-input",
        activeWriterRunId: "previous-writer",
        restartRecoveryDeliveryRunId: "accepted-input",
        restartRecoveryDeliveryRequestFingerprint: "accepted-fingerprint",
      });
    }
  });
});
