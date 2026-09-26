import { normalizeAgentRunTimeoutPhase } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { err, ok } from "@openclaw/normalization-core/result";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { withAgentCommandExecutionIdentitySpawnFacts } from "../../agents/agent-command-execution-identity-spawn.js";
import {
  buildAgentRunTerminalOutcome,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import type { PreparedAgentCommandRuntimeContext } from "../../agents/command/prepare.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { isTimeoutError } from "../../agents/failover-error.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { runWithCanonicalSkillWorkspace } from "../../agents/skill-workshop-workspace-context.js";
import {
  readAgentRunTerminalError,
  readAgentRunTerminalOutcome,
} from "../../channels/turn/agent-run-terminal-outcome.js";
import { agentCommandFromGatewayIngress } from "../../commands/agent.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { defaultRuntime } from "../../runtime.js";
import type { CreatedDetachedTaskRun } from "../../tasks/detached-task-runtime-contract.js";
import {
  prepareRunningTaskRun,
  type PreparedDetachedTaskRun,
} from "../../tasks/detached-task-runtime.js";
import { getTaskById } from "../../tasks/runtime-internal.js";
import { captureTaskCancellationControl } from "../../tasks/task-cancellation-context.js";
import type { FollowupReply } from "../../tasks/task-followup-completion.types.js";
import { mapAgentRunTerminalOutcomeToTaskStatus } from "../../tasks/task-registry-common.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { bindTaskRunOwner, getTaskRunOwner } from "../../tasks/task-run-owner.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import { errorShapeFromError } from "../error-shape.js";
import { tryFinalizeTrackedAgentTask } from "../server-methods/agent-task-tracking.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { captureAgentJobSession } from "./agent-job.js";
import { readAgentRunDispatchExecutionIdentity } from "./agent-run-dispatch-execution-identity.js";
import { readFollowupTerminalReply } from "./agent-run-dispatch-followup.js";
import {
  isGatewayAgentAbortRejection,
  projectRejectedGatewayStatus,
  RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION,
  resolveGatewayAgentAbortStopReason,
  resolveResolvedAgentTimeoutStopReason,
} from "./agent-run-dispatch-outcome.js";
import { createGatewayTaskExecutionBinding } from "./agent-run-task-binding.js";
import type { GatewayAgentDispatchTaskTracking } from "./agent-run-task-tracking.js";
import { bindGatewayAgentTerminalProducer } from "./agent-run-terminal-producer.js";
import type { AgentTurnContext, AgentTurnIo } from "./types.js";

export function resolveAbortedAgentStopReason(entry?: ChatAbortControllerEntry): string {
  return entry?.abortStopReason?.trim() || "rpc";
}

type TaskSettlementAdmission =
  | { taskTrackingMode: "none"; assertSettlementCurrent?: () => void }
  | {
      taskTrackingMode: Exclude<GatewayAgentDispatchTaskTracking, "none">;
      assertSettlementCurrent: () => void;
    };

export function dispatchAgentRunFromGateway(
  params: {
    assertCurrent?: () => void;
    admittedRunEntry: ChatAbortControllerEntry | undefined;
    ingressOpts: Parameters<typeof agentCommandFromGatewayIngress>[0];
    runId: string;
    cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
    dedupeKeys: readonly string[];
    /**
     * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
     * completion to drop the matching `chatAbortControllers` entry without
     * touching a same-runId entry owned by a concurrent chat.send.
     */
    abortController: AbortController;
    cleanupAbortController: () => void;
    io: AgentTurnIo;
    context: AgentTurnContext;
    canonicalSkillWorkspaceDir?: string;
    restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
    commandRuntimeContext?: PreparedAgentCommandRuntimeContext;
    onSettled?: (outcome: {
      terminalOutcome: AgentRunTerminalOutcome;
      onRecovered?: () => void;
    }) => Promise<boolean> | boolean;
  } & TaskSettlementAdmission,
) {
  const assertSettlementCurrent = params.assertSettlementCurrent;
  const registeredRunEntry = params.admittedRunEntry;
  const jobSessionBinding = registeredRunEntry ?? params.ingressOpts;
  const registeredRunInstance = registeredRunEntry?.operationalRunInstance;
  const registeredLifecycleGeneration = registeredRunEntry?.lifecycleGeneration;
  const registeredSessionKey = registeredRunEntry?.sessionKey;
  const ownsRunRegistration = () => {
    const current = params.context.chatAbortControllers.get(params.runId);
    return (
      !current ||
      (current === registeredRunEntry &&
        current.controller === params.abortController &&
        current.operationalRunInstance === registeredRunInstance &&
        current.lifecycleGeneration === registeredLifecycleGeneration &&
        current.sessionKey === registeredSessionKey)
    );
  };
  const assertCurrent = () => {
    // Preserve the run's recorded cancellation before a retired source rejects its authority.
    params.abortController.signal.throwIfAborted();
    params.assertCurrent?.();
    params.abortController.signal.throwIfAborted();
  };
  const registeredTask =
    typeof params.taskTrackingMode === "object" ? params.taskTrackingMode : undefined;
  const followupCompletion =
    registeredTask?.kind === "receipt" ? registeredTask.completion : undefined;
  let trackedTask: TaskRecord | undefined = registeredTask?.task;
  let createdTask: CreatedDetachedTaskRun | undefined =
    registeredTask?.kind === "receipt" ? registeredTask : undefined;
  let finalizeLegacyRun:
    | Extract<PreparedDetachedTaskRun, { kind: "legacy" }>["finalizeRun"]
    | undefined = registeredTask?.kind === "legacy" ? registeredTask.finalizeRun : undefined;
  let executionActivated = false;
  let originalTaskRunOwner: ReturnType<typeof getTaskRunOwner> =
    followupCompletion && trackedTask ? getTaskRunOwner(trackedTask) : undefined;
  const canSettleTrackedTask = (task: TaskRecord) => {
    const currentTaskOwner = getTaskRunOwner(task);
    if (currentTaskOwner && currentTaskOwner !== originalTaskRunOwner) {
      return false;
    }
    const successor = params.context.chatAbortControllers.get(params.runId);
    // A same-session successor may adopt this task before binding its run owner.
    return ownsRunRegistration() || successor?.sessionKey !== task.childSessionKey;
  };
  const settleTrackedTask = (
    terminal: Pick<
      Parameters<typeof tryFinalizeTrackedAgentTask>[0],
      "status" | "error" | "terminalSummary"
    > & { endedAt: number },
    reply: FollowupReply,
  ): void | Promise<void> => {
    const task = trackedTask;
    if (!task) {
      return;
    }
    if (followupCompletion) {
      if (!followupCompletion.ownsExecution(params.runId)) {
        return;
      }
      return (async () => {
        try {
          await followupCompletion.settle(params.runId, reply, () => {
            assertSettlementCurrent?.();
            if (!canSettleTrackedTask(task)) {
              throw new Error("Follow-up physical execution lost its Gateway registration.");
            }
          });
        } catch (error) {
          followupCompletion.close(error);
          throw error;
        }
      })();
    }
    if (!executionActivated && createdTask) {
      const settlementFailed = (error: unknown) => {
        params.context.logGateway.warn(
          `failed to settle unstarted tracked task ${task.taskId}: ${formatForLog(error)}`,
        );
      };
      try {
        return createdTask
          .settleUnstarted(terminal, canSettleTrackedTask)
          .then(() => undefined, settlementFailed);
      } catch (error) {
        settlementFailed(error);
      }
      return;
    }
    if (createdTask) {
      const settlementFailed = (error: unknown) => {
        params.context.logGateway.warn(
          `failed to finalize tracked agent task ${params.runId}: ${formatForLog(error)}`,
        );
      };
      try {
        if (!assertSettlementCurrent) {
          throw new Error("Active task settlement requires its Gateway admission");
        }
        return createdTask
          .finalizeActive(terminal, (current) => {
            assertSettlementCurrent();
            return canSettleTrackedTask(current);
          })
          .then(() => undefined, settlementFailed);
      } catch (error) {
        settlementFailed(error);
      }
      return;
    }
    if (canSettleTrackedTask(task)) {
      tryFinalizeTrackedAgentTask({
        finalizeRun: finalizeLegacyRun,
        ...terminal,
        runId: params.runId,
        sessionKey: task.childSessionKey,
        log: params.context.logGateway,
      });
    }
  };
  let createTrackedTask:
    | Extract<PreparedDetachedTaskRun, { kind: "receipt" }>["create"]
    | undefined;
  const creationFailed = (error: unknown) => {
    params.context.logGateway.warn(
      `failed to start tracked agent task ${params.runId}: ${formatForLog(error)}`,
    );
  };
  if (params.taskTrackingMode === "cli") {
    try {
      assertCurrent();
      const prepared = prepareRunningTaskRun(
        {
          runtime: "cli",
          sourceId: params.runId,
          ownerKey: params.ingressOpts.sessionKey,
          scopeKind: "session",
          requesterOrigin: normalizeDeliveryContext({
            channel: params.ingressOpts.channel,
            to: params.ingressOpts.to,
            accountId: params.ingressOpts.accountId,
            threadId: params.ingressOpts.threadId,
          }),
          childSessionKey: params.ingressOpts.sessionKey,
          runId: params.runId,
          task: params.ingressOpts.message,
          deliveryStatus: "not_applicable",
          startedAt: Date.now(),
        },
        assertCurrent,
      );
      if (prepared.kind === "legacy") {
        trackedTask = prepared.task ?? undefined;
        finalizeLegacyRun = prepared.finalizeRun;
      } else {
        createTrackedTask = prepared.create;
      }
    } catch (error) {
      creationFailed(error);
    }
  }

  const settle = async (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }): Promise<boolean> => {
    try {
      return (await params.onSettled?.(outcome)) ?? true;
    } catch (error) {
      params.context.logGateway.warn(
        `failed to settle agent continuation ${params.runId}: ${formatForLog(error)}`,
      );
      return false;
    }
  };
  let runOwnerCleanedUp = false;
  let releaseTaskOwner: (() => void) | undefined;
  let cancellationReason: string | undefined;
  const cleanupRunOwner = () => {
    if (runOwnerCleanedUp) {
      return;
    }
    runOwnerCleanedUp = true;
    if (ownsRunRegistration()) {
      clearAgentRunContext(params.runId, params.ingressOpts.lifecycleGeneration);
    }
    params.cleanupAbortController();
  };
  const cronCreatorAuthorityCapability = params.cronCreatorAuthority
    ? createCronCreatorAuthorityCapability(
        params.cronCreatorAuthority.runId,
        params.cronCreatorAuthority.callerOrigin,
        params.cronCreatorAuthority.managementEntitlement,
        params.cronCreatorAuthority.isCurrent,
        undefined,
        params.cronCreatorAuthority.requesterOwner,
        params.cronCreatorAuthority.callerScopedCreation,
      )
    : undefined;
  if (cronCreatorAuthorityCapability) {
    params.cronCreatorAuthority?.bindRunScope?.(cronCreatorAuthorityCapability);
  }
  const terminalProducer = bindGatewayAgentTerminalProducer({
    runId: params.runId,
    entry: registeredRunEntry,
    controller: params.abortController,
    ingressOpts: params.ingressOpts,
    chatAbortControllers: params.context.chatAbortControllers,
    isOwnerReleased: () => runOwnerCleanedUp,
  });
  const ingressOptsWithSpawnFacts = withAgentCommandExecutionIdentitySpawnFacts(
    { ...params.ingressOpts, beforeTerminalDelivery: terminalProducer.complete },
    readAgentRunDispatchExecutionIdentity(params),
  );
  const activateAgent = () => {
    assertCurrent();
    const task = trackedTask;
    // The original receipt keeps its immutable audit execution binding. A
    // successor has a new physical execution, not a replacement task row.
    const trackedTaskBinding =
      task && (!followupCompletion || task.runId === params.runId)
        ? createGatewayTaskExecutionBinding({
            task,
            runId: params.runId,
            assertCurrent,
            log: params.context.logGateway,
          })
        : undefined;
    const ingressOptsWithTaskBinding = task
      ? {
          ...ingressOptsWithSpawnFacts,
          onPostAdmittedRunContext: trackedTaskBinding?.onPostAdmission,
          onExecutionStarted: async () => {
            executionActivated = true;
            await ingressOptsWithSpawnFacts.onExecutionStarted?.();
            assertCurrent();
            await trackedTaskBinding?.onExecutionStarted();
          },
        }
      : ingressOptsWithSpawnFacts;
    const invoke = () =>
      runWithCanonicalSkillWorkspace(params.canonicalSkillWorkspaceDir, () =>
        agentCommandFromGatewayIngress(
          cronCreatorAuthorityCapability
            ? { ...ingressOptsWithTaskBinding, cronCreatorAuthorityCapability }
            : ingressOptsWithTaskBinding,
          defaultRuntime,
          params.context.deps,
          {
            restoreAdmittedRecovery: params.restoreAdmittedRecovery,
          },
          params.commandRuntimeContext,
        ),
      );
    const cancel = task && createTrackedTaskCancellation(task);
    const assertTaskOwnerCurrent = () => {
      assertCurrent();
      if (
        !ownsRunRegistration() ||
        params.context.chatAbortControllers.get(params.runId) !== registeredRunEntry
      ) {
        throw new Error("Task no longer owns its Gateway run registration.");
      }
    };
    if (followupCompletion && task) {
      followupCompletion.assertCurrent();
      originalTaskRunOwner = getTaskRunOwner(task);
      return followupCompletion
        .activate(params.runId, cancel, assertTaskOwnerCurrent)
        .then((release) => {
          releaseTaskOwner = release;
          assertTaskOwnerCurrent();
          followupCompletion.assertCurrent();
          return invoke();
        });
    }
    if (createdTask && task && cancel) {
      return createdTask.bindRunOwner(cancel, assertTaskOwnerCurrent).then((binding) => {
        releaseTaskOwner = binding.release;
        originalTaskRunOwner = binding.owner;
        assertTaskOwnerCurrent();
        if (getTaskRunOwner(task) !== binding.owner) {
          throw new Error("Task run owner was replaced before Gateway activation.");
        }
        return invoke();
      });
    }
    return invoke();
  };
  const runAgent = () => {
    try {
      assertCurrent();
      if (!createTrackedTask) {
        return activateAgent();
      }
      return createTrackedTask()
        .then((receipt) => {
          createdTask = receipt ?? undefined;
          trackedTask = receipt?.task;
        }, creationFailed)
        .then(activateAgent);
    } catch (error) {
      const failure = toErrorObject(error, formatErrorMessage(error));
      if (!(error instanceof Error)) {
        failure.cause = error;
      }
      return Promise.reject(failure);
    }
  };
  const agentExecution = cronCreatorAuthorityCapability
    ? runWithCronCreatorAuthorityCapability(
        cronCreatorAuthorityCapability,
        runAgent,
        params.abortController.signal,
      )
    : runAgent();
  // Startup failures may never enter command finalization; delivery already joined this boundary.
  const agentRun = terminalProducer.settle(agentExecution);
  let inputCompletionWriteFailed = false;
  const runCompletion = agentRun
    .then(async (result) => {
      const recordedOutcome = readAgentRunTerminalOutcome(result);
      const signalStopReason = resolveResolvedAgentTimeoutStopReason(
        result?.meta,
        params.abortController.signal,
      );
      const aborted = result?.meta?.aborted === true || signalStopReason !== undefined;
      const stopReason = signalStopReason
        ? signalStopReason
        : aborted
          ? (result?.meta?.stopReason ?? "rpc")
          : undefined;
      const timeoutPhase = normalizeAgentRunTimeoutPhase(result?.meta?.timeoutPhase);
      const terminalError = readAgentRunTerminalError(result) ?? result?.meta?.error?.message;
      let terminalOutcome = buildAgentRunTerminalOutcome({
        status:
          aborted || result?.meta?.stopReason === "timeout" || timeoutPhase
            ? "timeout"
            : recordedOutcome === "failed" ||
                result?.meta?.error ||
                result?.meta?.stopReason === "error"
              ? "error"
              : "ok",
        error: terminalError ? formatErrorMessage(terminalError) : undefined,
        stopReason: stopReason ?? result?.meta?.stopReason,
        livenessState: result?.meta?.livenessState,
        timeoutPhase,
        providerStarted: result?.meta?.providerStarted,
      });
      let recordedInputCompletion: AgentRunTerminalOutcome | undefined;
      try {
        recordedInputCompletion =
          params.ingressOpts.userTurnTranscriptRecorder?.completeProcessing?.(terminalOutcome);
        terminalOutcome = recordedInputCompletion ?? terminalOutcome;
      } catch (error) {
        inputCompletionWriteFailed = true;
        throw error;
      }
      const responseStatus =
        RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION[
          classifyAgentRunTerminalOutcome(terminalOutcome)
        ];
      const taskStatus = mapAgentRunTerminalOutcomeToTaskStatus(terminalOutcome);
      const endedAt = terminalOutcome.endedAt ?? Date.now();
      const taskSettlement = settleTrackedTask(
        {
          status: taskStatus,
          error:
            taskStatus === "cancelled"
              ? (cancellationReason ?? terminalOutcome.error)
              : terminalOutcome.error,
          terminalSummary:
            responseStatus === "timeout"
              ? "aborted"
              : responseStatus === "error"
                ? "failed"
                : "completed",
          endedAt,
        },
        {
          ...terminalOutcome,
          error:
            taskStatus === "cancelled"
              ? (cancellationReason ?? terminalOutcome.error)
              : terminalOutcome.error,
          endedAt,
          yielded: result?.meta?.yielded === true,
          ...readFollowupTerminalReply(params.runId, result?.meta),
        },
      );
      if (taskSettlement) {
        await taskSettlement;
      }
      const payload = {
        runId: params.runId,
        status: responseStatus,
        summary:
          responseStatus === "timeout"
            ? "aborted"
            : responseStatus === "error"
              ? "failed"
              : "completed",
        ...(responseStatus !== "ok" && terminalOutcome.stopReason
          ? { stopReason: terminalOutcome.stopReason }
          : {}),
        ...(responseStatus === "timeout" && terminalOutcome.timeoutPhase
          ? { timeoutPhase: terminalOutcome.timeoutPhase }
          : {}),
        ...(responseStatus === "timeout" && terminalOutcome.providerStarted !== undefined
          ? { providerStarted: terminalOutcome.providerStarted }
          : {}),
        result,
      };
      const inputProcessingCompleted =
        recordedInputCompletion?.reason === "completed" && responseStatus === "ok";
      const persistTerminalDedupe = () => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          session: captureAgentJobSession(jobSessionBinding),
          entry: {
            ts: Date.now(),
            ok: true,
            payload: {
              ...payload,
              ...(inputProcessingCompleted ? { inputProcessingCompleted: true } : {}),
            },
          },
        });
      };
      const settled = await settle({ terminalOutcome, onRecovered: persistTerminalDedupe });
      if (!settled) {
        const summary = "failed to persist cron continuation settlement";
        const error = errorShape(ErrorCodes.UNAVAILABLE, summary);
        const failedPayload = { runId: params.runId, status: "error" as const, summary };
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          session: captureAgentJobSession(jobSessionBinding),
          entry: { ts: Date.now(), ok: false, payload: failedPayload, error },
        });
        cleanupRunOwner();
        params.io.emitFinal([false, failedPayload, error], {
          runId: params.runId,
          error: summary,
        });
        return { terminalOutcome, settled };
      }
      persistTerminalDedupe();
      // A final response resumes durable delivery cleanup. Release the terminal
      // run owner first so exact-session deletion cannot race this admission.
      cleanupRunOwner();
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.io.emitFinal(
        [
          true,
          { ...payload, ...(inputProcessingCompleted ? { inputProcessingCompleted: true } : {}) },
          undefined,
        ],
        { runId: params.runId },
      );
      return { terminalOutcome, settled };
    })
    .catch(async (cause: unknown) => {
      const aborted = isGatewayAgentAbortRejection(cause, params.abortController.signal);
      const error = errorShapeFromError(ErrorCodes.UNAVAILABLE, cause);
      const renderedErr = error.message;
      const stopReason = aborted
        ? resolveGatewayAgentAbortStopReason(params.abortController.signal)
        : isAbortError(cause)
          ? "aborted"
          : undefined;
      let terminalOutcome = buildAgentRunTerminalOutcome({
        status: aborted || isTimeoutError(cause) ? "timeout" : "error",
        error: renderedErr,
        stopReason,
        timeoutPhase: stopReason === "restart" ? "gateway_draining" : undefined,
      });
      // A failed required write cannot be its own retry loop. Publish failure
      // and release the accepted owner even while the receipt store is unavailable.
      if (!inputCompletionWriteFailed) {
        try {
          terminalOutcome =
            params.ingressOpts.userTurnTranscriptRecorder?.completeProcessing?.(terminalOutcome) ??
            terminalOutcome;
        } catch (completionError) {
          params.context.logGateway.warn(
            `input completion persistence failed: ${formatForLog(completionError)}`,
          );
        }
      }
      const responseStatus = projectRejectedGatewayStatus(terminalOutcome);
      const taskStatus = mapAgentRunTerminalOutcomeToTaskStatus(terminalOutcome);
      const taskSettlement = settleTrackedTask(
        {
          status: taskStatus,
          error: taskStatus === "cancelled" ? (cancellationReason ?? renderedErr) : renderedErr,
          terminalSummary: renderedErr,
          endedAt: Date.now(),
        },
        {
          ...terminalOutcome,
          error: taskStatus === "cancelled" ? (cancellationReason ?? renderedErr) : renderedErr,
          endedAt: Date.now(),
        },
      );
      if (taskSettlement) {
        await taskSettlement;
      }
      Object.defineProperty(error, "cause", { value: cause });
      const payload = {
        runId: params.runId,
        status: responseStatus,
        summary: aborted ? "aborted" : renderedErr,
        ...(aborted
          ? {
              stopReason,
              ...(terminalOutcome.timeoutPhase
                ? { timeoutPhase: terminalOutcome.timeoutPhase }
                : {}),
            }
          : {}),
      };
      const persistTerminalDedupe = (settlementPersisted: boolean) => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          session: captureAgentJobSession(jobSessionBinding),
          entry: {
            ts: Date.now(),
            ok: aborted && settlementPersisted,
            payload,
            ...(aborted ? {} : { error }),
          },
        });
      };
      const settled = await settle({
        terminalOutcome,
        onRecovered: () => persistTerminalDedupe(true),
      });
      persistTerminalDedupe(settled);
      cleanupRunOwner();
      params.io.emitFinal([aborted && settled, payload, aborted && settled ? undefined : error], {
        runId: params.runId,
        ...(aborted ? {} : { error: renderedErr }),
      });
      return { terminalOutcome, settled };
    })
    .finally(() => {
      cleanupRunOwner();
      releaseTaskOwner?.();
      followupCompletion?.finishExecution(params.runId);
    });

  if (finalizeLegacyRun && trackedTask) {
    const cancel = createTrackedTaskCancellation(trackedTask);
    if (cancel) {
      releaseTaskOwner = bindTaskRunOwner(trackedTask, cancel);
      originalTaskRunOwner = getTaskRunOwner(trackedTask);
    }
  }

  function createTrackedTaskCancellation(
    task: TaskRecord,
  ): Parameters<typeof bindTaskRunOwner>[1] | undefined {
    const entry = registeredRunEntry;
    if (entry?.controller === params.abortController) {
      const taskId = task.taskId;
      const operationalRunInstance = registeredRunInstance;
      const lifecycleGeneration = registeredLifecycleGeneration;
      const sessionKey = registeredSessionKey;
      return async (reason) => {
        const authority = entry.agentRunDelegatedAuthority;
        if (
          !operationalRunInstance ||
          !lifecycleGeneration ||
          !sessionKey ||
          !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
          params.context.chatAbortControllers.get(params.runId) !== entry ||
          entry.controller !== params.abortController ||
          entry.lifecycleGeneration !== lifecycleGeneration ||
          entry.operationalRunInstance !== operationalRunInstance ||
          entry.sessionKey !== sessionKey ||
          task.childSessionKey !== sessionKey ||
          entry.registrationCleanupRequested ||
          (entry.executionStarted && !authority) ||
          (authority &&
            (authority.operationalRunInstance !== operationalRunInstance ||
              !validateAgentRunDelegatedAuthority(authority)))
        ) {
          return err("Task no longer owns an active Gateway run.");
        }
        captureTaskCancellationControl()?.assertCurrent();
        const result = abortChatRunById(createChatAbortOps(params.context), {
          runId: params.runId,
          sessionKey,
          stopReason: "rpc",
        });
        if (!result.aborted) {
          return err("Task run did not accept cancellation.");
        }
        cancellationReason = reason;
        // Lifecycle projection can finish before tools unwind. Wait on this exact producer.
        const outcome = await withTimeout(runCompletion, 10_000, "Task cancellation settlement");
        const current = getTaskById(taskId);
        if (
          !outcome.settled ||
          classifyAgentRunTerminalOutcome(outcome.terminalOutcome) !== "cancellation" ||
          current?.status !== "cancelled"
        ) {
          return err("Task cancellation was not confirmed. Inspect its final result.");
        }
        return ok(current);
      };
    }
    return undefined;
  }
  // Gateway shutdown must join this execution, not just its admission.
  return runCompletion;
}
