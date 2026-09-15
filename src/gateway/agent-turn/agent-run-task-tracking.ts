/** Prepares Gateway task tracking without competing with the registry's task owner. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
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
  const taskTrackingMode = resolveGatewayAgentTaskTrackingMode({
    client: params.client,
    sessionKey: params.resolvedSessionKey,
    inputProvenance: params.inputProvenance,
    confirmedAcpManualSpawn: isConfirmedAcpManualSpawnTaskOwner({
      acpTurnSource: params.request.acpTurnSource,
      sessionKey: params.resolvedSessionKey,
      client: params.client,
      logGateway: params.context.logGateway,
    }),
    modelRun: params.isOneShotModelRun,
    runId: params.runId,
  });
  if (taskTrackingMode === "plugin_subagent" && params.resolvedSessionKey) {
    try {
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
