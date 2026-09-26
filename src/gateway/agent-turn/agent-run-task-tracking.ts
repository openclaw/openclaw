/** Prepares Gateway task tracking without competing with the registry's task owner. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  readFollowupRequest,
  readFollowupSuccessor,
  SessionFollowupCompletion,
} from "../../agents/subagents/completion/session-followup-completion.js";
import type {
  FollowupCompletionOwner,
  FollowupSuccessor,
} from "../../agents/subagents/completion/session-followup-completion.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type {
  CreatedDetachedTaskRun,
  DetachedRunningTaskCreateParams,
} from "../../tasks/detached-task-runtime-contract.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime-state.js";
import {
  prepareRunningTaskRun,
  type PreparedDetachedTaskRun,
} from "../../tasks/detached-task-runtime.js";
import { findTaskViewByRunIdAsync } from "../../tasks/runtime-internal.js";
import {
  bindFollowupTaskProjection,
  projectFollowupTaskTerminal,
} from "../../tasks/task-followup-projection.js";
import { mapAgentRunTerminalOutcomeToTaskStatus } from "../../tasks/task-registry-common.js";
import { isTerminalTaskStatus, type TaskRecord } from "../../tasks/task-registry.types.js";
import { getTaskRunOwner } from "../../tasks/task-run-owner.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import {
  isConfirmedAcpManualSpawnTaskOwner,
  registerPluginSubagentRunFromGateway,
  resolveGatewayAgentTaskTrackingMode,
  type GatewayAgentTaskTrackingMode,
} from "../server-methods/agent-task-tracking.js";
import { prepareParentSubagentResume } from "../session-subagent-resume.js";
import { formatForLog } from "../ws-log.js";
import type { AgentTurnContext, AgentTurnPrincipal } from "./types.js";

export type RegisteredGatewayAgentTask =
  | (Extract<PreparedDetachedTaskRun, { kind: "legacy" }> & { task: TaskRecord })
  | (CreatedDetachedTaskRun & { kind: "receipt"; completion?: FollowupCompletionOwner });

export type GatewayAgentDispatchTaskTracking = "cli" | "none" | RegisteredGatewayAgentTask;

/** A child follow-up must retain its task before the caller receives acceptance. */
export async function registerSessionFollowupTask(params: {
  followup: Extract<GatewayAgentTaskTrackingMode, { kind: "session_followup" }>;
  runId: string;
  sessionKey: string;
  task: string;
  requesterOrigin: DetachedRunningTaskCreateParams["requesterOrigin"];
  assertCurrent: () => void;
}): Promise<RegisteredGatewayAgentTask> {
  if (params.followup.existingTaskStatus) {
    throw new Error(
      `Follow-up task is already ${params.followup.existingTaskStatus}; run was not started.`,
    );
  }
  const request = readFollowupRequest(params.runId, params.sessionKey);
  if (request && request.requesterSessionKey !== params.followup.requesterSessionKey) {
    throw new Error("Follow-up requester does not match its completion custody.");
  }
  request?.custody.assertCurrent();
  // Custom runtimes create synchronously in prepareRunningTaskRun. Reject before
  // that side effect when completion custody requires a worker-owned receipt.
  if (request && getRegisteredDetachedTaskLifecycleRuntime()) {
    throw new Error("Follow-up completion requires a task creation receipt.");
  }
  const prepared = prepareRunningTaskRun(
    {
      runtime: "cli",
      sourceId: params.runId,
      ownerKey: params.followup.requesterSessionKey,
      requesterSessionKey: params.followup.requesterSessionKey,
      label: params.followup.label,
      notifyPolicy: "silent",
      scopeKind: "session",
      requesterOrigin: params.requesterOrigin,
      childSessionKey: params.sessionKey,
      runId: params.runId,
      task: params.task,
      deliveryStatus: "not_applicable",
      startedAt: Date.now(),
    },
    params.assertCurrent,
  );
  if (prepared.kind === "legacy") {
    if (request) {
      throw new Error("Follow-up completion requires a task creation receipt.");
    }
    const task = prepared.task;
    if (task && !isTerminalTaskStatus(task.status)) {
      return { ...prepared, task };
    }
  } else {
    const receipt = await prepared.create();
    if (receipt && !isTerminalTaskStatus(receipt.task.status)) {
      if (!request) {
        return { kind: "receipt", ...receipt };
      }
      try {
        params.assertCurrent();
        const completion = SessionFollowupCompletion.bind(request, params.assertCurrent);
        try {
          await bindFollowupTaskProjection(completion, receipt, params.assertCurrent);
        } catch (error) {
          completion.close(error);
          throw error;
        }
        request.completion = completion;
        return { kind: "receipt", ...receipt, completion };
      } catch (error) {
        await receipt.settleUnstarted(
          { status: "failed", endedAt: Date.now(), error: formatForLog(error) },
          (task) => !getTaskRunOwner(task),
        );
        throw error;
      }
    }
  }
  throw new Error("Follow-up task registration failed; run was not started.");
}

/** Rejection retains the creation receipt rather than resolving a replacement runtime. */
export async function settleUnstartedGatewayAgentTask(params: {
  tracking: GatewayAgentDispatchTaskTracking;
  runId: string;
  admittedRunEntry: ChatAbortControllerEntry | undefined;
  context: Pick<AgentTurnContext, "chatAbortControllers" | "logGateway">;
  outcome: AgentRunTerminalOutcome;
}): Promise<void> {
  const tracking = params.tracking;
  if (typeof tracking !== "object") {
    return;
  }
  const canSettle = (task: TaskRecord) => {
    if (getTaskRunOwner(task)) {
      return false;
    }
    // A successor for this run ID and session can adopt the task before binding its task owner.
    const current = params.context.chatAbortControllers.get(params.runId);
    return current === params.admittedRunEntry || current?.sessionKey !== task.childSessionKey;
  };
  const terminal = {
    status: mapAgentRunTerminalOutcomeToTaskStatus(params.outcome),
    endedAt: Date.now(),
    error: params.outcome.error,
    terminalSummary: params.outcome.error ?? "Follow-up run was not started.",
  };
  try {
    if (tracking.kind === "receipt" && tracking.completion) {
      // Preparation cannot terminalize a paused predecessor. Only the execution
      // synchronously adopted at final admission owns this outcome.
      if (tracking.completion.ownsExecution(params.runId)) {
        tracking.completion.assertCurrent();
        const assertAdmissionCurrent = () => {
          const current = params.context.chatAbortControllers.get(params.runId);
          if (current && current !== params.admittedRunEntry) {
            throw new Error("Follow-up admission was replaced before cleanup.");
          }
        };
        const decision = await tracking.completion.settle(
          params.runId,
          {
            ...params.outcome,
            endedAt: terminal.endedAt,
          },
          assertAdmissionCurrent,
        );
        if (decision.kind === "terminal") {
          await projectFollowupTaskTerminal(
            tracking.completion,
            decision.reply,
            assertAdmissionCurrent,
          );
        }
      } else if (
        !tracking.completion.accepted &&
        tracking.completion.request.runId === params.runId
      ) {
        // Revocation closes execution custody, not the original creation receipt's cleanup obligation.
        // A rejected successor must never use this to terminalize its paused predecessor.
        await tracking.settleUnstarted(terminal, canSettle);
      }
      tracking.completion.finishExecution(params.runId);
    } else if (tracking.kind === "receipt") {
      await tracking.settleUnstarted(terminal, canSettle);
    } else if (canSettle(tracking.task)) {
      tracking.finalizeRun({
        ...terminal,
        runtime: "cli",
        runId: params.runId,
        taskId: tracking.task.taskId,
        sessionKey: tracking.task.childSessionKey,
      });
    }
  } catch (error) {
    if (tracking.kind === "receipt") {
      tracking.completion?.close(error);
    }
    params.context.logGateway.warn(
      `failed to settle unstarted follow-up task ${tracking.task.taskId}: ${formatForLog(error)}`,
    );
  }
}

/** Registers ordinary plugin work or prepares an explicit paused-task transfer for final admission. */
export async function prepareAgentRunTaskTracking(params: {
  cfg: OpenClawConfig;
  client: AgentTurnPrincipal | null;
  resolvedSessionKey?: string;
  inputProvenance?: InputProvenance;
  canUseInternalRuntimeHandoff: boolean;
  sessionEntry?: SessionEntry;
  request: Pick<AgentRunRequest, "message" | "acpTurnSource">;
  isOneShotModelRun: boolean;
  runId: string;
  getAdmittedSessionId: () => string;
  assertResumeAdmissionCurrent: () => void;
  context: Pick<AgentTurnContext, "logGateway" | "resolveGatewayContext">;
}): Promise<{
  taskTrackingMode: GatewayAgentTaskTrackingMode;
  adoptParentResume?: () => string;
  followupSuccessor?: FollowupSuccessor;
}> {
  const followupSuccessor = params.resolvedSessionKey
    ? readFollowupSuccessor(params.runId, params.resolvedSessionKey)
    : undefined;
  if (followupSuccessor) {
    params.assertResumeAdmissionCurrent();
    await followupSuccessor.owner.prepareSuccessor(followupSuccessor);
    params.assertResumeAdmissionCurrent();
    followupSuccessor.assertCurrent();
    return { taskTrackingMode: "none", followupSuccessor };
  }
  const resume = readInProcessSubagentResume(params.client?.internal);
  if (resume) {
    return {
      taskTrackingMode: "none",
      adoptParentResume: await prepareParentSubagentResume({
        cfg: params.cfg,
        resume,
        sessionKey: params.resolvedSessionKey,
        getSessionId: params.getAdmittedSessionId,
        runId: params.runId,
        task: params.request.message,
        assertAdmissionCurrent: params.assertResumeAdmissionCurrent,
        gatewayContextResolver: params.context.resolveGatewayContext,
      }),
    };
  }
  const existingTask =
    !params.isOneShotModelRun && params.resolvedSessionKey?.trim() && params.runId.trim()
      ? await findTaskViewByRunIdAsync(params.runId, params.assertResumeAdmissionCurrent)
      : undefined;
  params.assertResumeAdmissionCurrent();
  const confirmedAcpManualSpawn = await isConfirmedAcpManualSpawnTaskOwner({
    acpTurnSource: params.request.acpTurnSource,
    sessionKey: params.resolvedSessionKey,
    client: params.client,
    assertCurrent: params.assertResumeAdmissionCurrent,
  });
  params.assertResumeAdmissionCurrent();
  const taskTrackingMode = resolveGatewayAgentTaskTrackingMode({
    client: params.client,
    sessionKey: params.resolvedSessionKey,
    inputProvenance: params.inputProvenance,
    canUseInternalRuntimeHandoff: params.canUseInternalRuntimeHandoff,
    sessionEntry: params.sessionEntry,
    confirmedAcpManualSpawn,
    modelRun: params.isOneShotModelRun,
    existingTask,
  });
  if (taskTrackingMode === "plugin_subagent" && params.resolvedSessionKey) {
    try {
      params.assertResumeAdmissionCurrent();
      await registerPluginSubagentRunFromGateway({
        assertAdmissionCurrent: params.assertResumeAdmissionCurrent,
        cfg: params.cfg,
        runId: params.runId,
        childSessionKey: params.resolvedSessionKey,
        task: params.request.message.trim(),
        requester: params.client?.internal?.pluginSubagentRequester,
        pluginId: normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId),
        gatewayContextResolver: params.context.resolveGatewayContext,
      });
    } catch (error) {
      params.context.logGateway.warn(
        `failed to register plugin subagent run ${params.runId}; rejecting untracked dispatch: ${formatForLog(error)}`,
      );
      throw new Error("plugin subagent registry persistence failed; run was not started", {
        cause: error,
      });
    }
  }
  return { taskTrackingMode };
}
