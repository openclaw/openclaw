/** Native subagent registration and paused-run adoption precede Gateway acceptance. */
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
import { getLatestLiveSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry-read.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { registerPluginSubagentRunFromGateway } from "../server-methods/agent-subagent-registration.js";
import { prepareParentSubagentResume } from "../session-subagent-resume.js";
import { formatForLog } from "../ws-log.js";
import { createAgentRunDiagnostics } from "./agent-run-diagnostics.js";
import type { AgentTurnContext, AgentTurnPrincipal } from "./types.js";

export async function prepareGatewaySubagentRun(params: {
  cfg: OpenClawConfig;
  client: AgentTurnPrincipal | null;
  resolvedSessionKey?: string;
  inputProvenance?: InputProvenance;
  sessionEntry?: SessionEntry;
  request: Pick<AgentRunRequest, "message">;
  isOneShotModelRun: boolean;
  runId: string;
  getAdmittedSessionId: () => string;
  assertResumeAdmissionCurrent: () => void;
  context: Pick<AgentTurnContext, "resolveGatewayContext"> & {
    logGateway: Pick<AgentTurnContext["logGateway"], "warn">;
  };
}): Promise<{
  pluginSubagent: boolean;
  reactivateSubagent: boolean;
  adoptParentResume?: () => string;
  followupCompletion?: FollowupCompletionOwner;
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
    return {
      pluginSubagent: false,
      reactivateSubagent: false,
      followupCompletion: followupSuccessor.owner,
      followupSuccessor,
    };
  }
  const resume = readInProcessSubagentResume(params.client?.internal);
  if (resume) {
    return {
      pluginSubagent: false,
      reactivateSubagent: false,
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
  const sessionKey = params.resolvedSessionKey?.trim();
  const request = sessionKey ? readFollowupRequest(params.runId, sessionKey) : undefined;
  if (request) {
    if (request.requesterSessionKey !== params.inputProvenance?.sourceSessionKey) {
      throw new Error("Follow-up requester does not match its completion custody.");
    }
    const completion = SessionFollowupCompletion.bind(request, params.assertResumeAdmissionCurrent);
    request.completion = completion;
    return {
      pluginSubagent: false,
      reactivateSubagent: false,
      followupCompletion: completion,
    };
  }
  const internalOwner = params.client?.internal?.agentRunTracking;
  const interSession = params.inputProvenance?.kind === "inter_session";
  const pluginSubagent = Boolean(
    !params.isOneShotModelRun &&
    sessionKey &&
    (interSession
      ? params.inputProvenance?.sourceTool === "subagent_settle" &&
        getLatestLiveSubagentRunByChildSessionKey(
          sessionKey,
          (entry) => entry.pauseReason === "sessions_yield",
        )
      : internalOwner === "plugin_subagent"),
  );
  params.assertResumeAdmissionCurrent();
  if (pluginSubagent && sessionKey) {
    // Persist the actual execution owner before acknowledging a plugin dispatch.
    try {
      await registerPluginSubagentRunFromGateway({
        cfg: params.cfg,
        runId: params.runId,
        childSessionKey: sessionKey,
        task: params.request.message.trim(),
        requester: params.client?.internal?.pluginSubagentRequester,
        pluginId: normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId),
        assertCurrent: params.assertResumeAdmissionCurrent,
        gatewayContextResolver: params.context.resolveGatewayContext,
      });
    } catch (error) {
      params.assertResumeAdmissionCurrent();
      params.context.logGateway.warn(
        `failed to register plugin subagent run ${params.runId}; rejecting untracked dispatch: ${formatForLog(error)}`,
      );
      throw new Error("plugin subagent registry persistence failed; run was not started", {
        cause: error,
      });
    }
  }
  return {
    pluginSubagent,
    // Operator follow-ups may continue a child; inter-session delivery retains its own owner.
    reactivateSubagent: Boolean(
      sessionKey &&
      !params.isOneShotModelRun &&
      !interSession &&
      !pluginSubagent &&
      internalOwner !== "native_subagent" &&
      !params.sessionEntry?.acp &&
      !isAcpSessionKey(sessionKey),
    ),
  };
}

/** Rejection may settle only the exact physical execution already adopted by this admission. */
export async function settleUnstartedGatewayFollowup(params: {
  completion: FollowupCompletionOwner | undefined;
  runId: string;
  admittedRunEntry: ChatAbortControllerEntry | undefined;
  admittedRunIdentity:
    | Pick<
        ChatAbortControllerEntry,
        "controller" | "operationalRunInstance" | "lifecycleGeneration" | "sessionKey"
      >
    | undefined;
  context: Pick<AgentTurnContext, "chatAbortControllers" | "logGateway">;
  isIncognito?: boolean;
  outcome: AgentRunTerminalOutcome;
}): Promise<void> {
  const completion = params.completion;
  if (!completion?.ownsExecution(params.runId)) {
    return;
  }
  try {
    await completion.settle(
      params.runId,
      { ...params.outcome, endedAt: params.outcome.endedAt ?? Date.now() },
      () => {
        const current = params.context.chatAbortControllers.get(params.runId);
        const admitted = params.admittedRunIdentity;
        const ownsRegistration =
          current === params.admittedRunEntry &&
          admitted &&
          current?.controller === admitted.controller &&
          current.operationalRunInstance === admitted.operationalRunInstance &&
          current.lifecycleGeneration === admitted.lifecycleGeneration &&
          current.sessionKey === admitted.sessionKey;
        if (
          current &&
          !ownsRegistration &&
          (current === params.admittedRunEntry ||
            current.sessionKey === completion.request.targetSessionKey)
        ) {
          throw new Error("Follow-up admission was replaced before cleanup.");
        }
      },
    );
  } catch (error) {
    completion.close(error);
    createAgentRunDiagnostics(
      completion.request.targetSessionKey,
      params.isIncognito,
      params.context.logGateway,
    ).warning(`failed to settle unstarted follow-up ${params.runId}`)(error);
  }
}
