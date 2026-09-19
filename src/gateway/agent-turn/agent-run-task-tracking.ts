/** Prepares Gateway task tracking without competing with the registry's task owner. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { findTaskViewByRunIdAsync } from "../../tasks/runtime-internal.js";
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
}): Promise<{ taskTrackingMode: GatewayAgentTaskTrackingMode; adoptParentResume?: () => string }> {
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
  const taskTrackingMode = resolveGatewayAgentTaskTrackingMode({
    client: params.client,
    sessionKey: params.resolvedSessionKey,
    inputProvenance: params.inputProvenance,
    canUseInternalRuntimeHandoff: params.canUseInternalRuntimeHandoff,
    sessionEntry: params.sessionEntry,
    confirmedAcpManualSpawn: isConfirmedAcpManualSpawnTaskOwner({
      acpTurnSource: params.request.acpTurnSource,
      sessionKey: params.resolvedSessionKey,
      client: params.client,
      logGateway: params.context.logGateway,
    }),
    modelRun: params.isOneShotModelRun,
    existingTask,
  });
  if (taskTrackingMode === "plugin_subagent" && params.resolvedSessionKey) {
    try {
      params.assertResumeAdmissionCurrent();
      await registerPluginSubagentRunFromGateway({
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
