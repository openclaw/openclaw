/** Parent task continuation with one completion owner across execution turns. */
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindInProcessSubagentResume } from "../../gateway/in-process-subagent-resume.js";
import type { TrustedAgentToolCaller } from "../../gateway/server-methods/types.js";
import { bindParentSubagentResume } from "../../gateway/session-subagent-resume.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { loadSessionEntryByKey } from "../subagents/announce/subagent-announce-delivery.js";
import { jsonResult } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { recordSessionToolActionFact } from "./sessions-helpers.js";

/** Retain the admitted caller before asynchronous session resolution. */
export function captureSessionsSendResumeCaller(): TrustedAgentToolCaller | undefined {
  const caller = getGatewayToolCallerIdentity();
  const assertCurrent = captureGatewayToolCallerAssertion();
  return caller && assertCurrent
    ? { agentId: caller.agentId, sessionKey: caller.sessionKey, assertCurrent }
    : undefined;
}

/** Dispatches one exact paused-task successor and leaves final delivery to its registry owner. */
export async function resumeSessionsSendTask(params: {
  cfg: OpenClawConfig;
  caller: TrustedAgentToolCaller;
  targetAgentId: string;
  sessionKey: string;
  displayKey: string;
  runId: string;
  expectedSessionId?: string;
  sendParams: Record<string, unknown>;
  callGateway: AgentToolGatewayRequestCaller;
}): Promise<ReturnType<typeof jsonResult>> {
  try {
    const entry = loadSessionEntryByKey(params.sessionKey, params.targetAgentId);
    if (
      !entry ||
      entry.archivedAt !== undefined ||
      readAcpSessionMeta({
        cfg: params.cfg,
        agentId: params.targetAgentId,
        sessionKey: params.sessionKey,
      }) ||
      (params.expectedSessionId && entry.sessionId !== params.expectedSessionId)
    ) {
      throw new Error("Task resume requires the existing, unarchived native child session.");
    }
    const subagentResume = bindParentSubagentResume({
      cfg: params.cfg,
      caller: params.caller,
      childSessionKey: params.sessionKey,
      childSessionId: entry.sessionId,
    });
    const accepted = await params.callGateway<{
      runId: string;
      taskRunId: string;
      status: string;
    }>(
      bindInProcessSubagentResume(
        {
          method: "agent",
          params: {
            ...params.sendParams,
            expectedExistingSessionId: subagentResume.childSessionId,
          },
          assertDispatchCurrent: params.caller.assertCurrent,
          timeoutMs: 10_000,
        },
        subagentResume,
      ),
    );
    if (accepted.status !== "accepted" || accepted.taskRunId !== subagentResume.taskRunId) {
      throw new Error(
        "Gateway did not confirm the task resume; inspect subagents before retrying.",
      );
    }
    recordSessionToolActionFact({
      operation: "send",
      fact: "committed",
      targetAgentId: params.targetAgentId,
      targetSessionKey: params.sessionKey,
    });
    // No agent.wait, watch registration, or A2A flow may compete with task completion.
    return jsonResult({
      status: "accepted",
      mode: "resume",
      runId: accepted.runId,
      taskRunId: accepted.taskRunId,
      sessionKey: params.displayKey,
      completion: "task",
    });
  } catch (error) {
    return jsonResult({
      status: "error",
      runId: params.runId,
      sessionKey: params.displayKey,
      error: formatErrorMessage(error),
    });
  }
}
