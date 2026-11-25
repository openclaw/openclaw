import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
/** Parent task continuation with one completion owner across execution turns. */
import { readAcpSessionEntryAsync } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readAgentSelfHeldRefusal } from "../../gateway/agent-turn/agent-admission-refusal.js";
import { bindInProcessSubagentResume } from "../../gateway/in-process-subagent-resume.js";
import type { TrustedAgentToolCaller } from "../../gateway/server-methods/types.js";
import { bindParentSubagentResume } from "../../gateway/session-subagent-resume.js";
import { jsonResult } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { recordSessionToolActionFact } from "./sessions-helpers.js";

/** Retain the admitted caller before asynchronous session resolution. */
export function captureSessionsSendResumeCaller(
  retainedSourceAssertion?: () => void,
): TrustedAgentToolCaller | undefined {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    return undefined;
  }
  // A host-retained replay has no live model turn. Its existing handoff supplies
  // the independently retained source + original conversation fence instead.
  if (caller.operationalRunInstance) {
    return { agentId: caller.agentId, sessionKey: caller.sessionKey };
  }
  return retainedSourceAssertion
    ? {
        agentId: caller.agentId,
        sessionKey: caller.sessionKey,
        assertCurrent: retainedSourceAssertion,
      }
    : undefined;
}

/** Dispatches one exact paused-task successor and leaves final delivery to its registry owner. */
export async function resumeSessionsSendTask(params: {
  cfg: OpenClawConfig;
  caller: TrustedAgentToolCaller;
  assertCurrent?: () => void;
  targetAgentId: string;
  sessionKey: string;
  displayKey: string;
  runId: string;
  sendParams: Record<string, unknown>;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  try {
    params.assertCurrent?.();
    const session = await readAcpSessionEntryAsync({
      cfg: params.cfg,
      agentId: params.targetAgentId,
      sessionKey: params.sessionKey,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
    const entry = session?.entry;
    if (!entry || entry.archivedAt !== undefined || session.acp) {
      throw new Error("Task resume requires the existing, unarchived native child session.");
    }
    // Bound to the task's current paused run at dispatch; never replayed from an earlier capture.
    const subagentResume = bindParentSubagentResume({
      cfg: params.cfg,
      caller: params.caller,
      childSessionKey: params.sessionKey,
      childSessionId: entry.sessionId,
      childLifecycleRevision: entry.lifecycleRevision,
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
          sessionMutationCommitGuard: params.assertCurrent,
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
    return {
      result: jsonResult({
        status: "accepted",
        mode: "resume",
        runId: accepted.runId,
        taskRunId: accepted.taskRunId,
        sessionKey: params.displayKey,
        completion: "task",
      }),
    };
  } catch (error) {
    return {
      selfHeld: readAgentSelfHeldRefusal(error),
      result: jsonResult({
        status: "error",
        runId: params.runId,
        sessionKey: params.displayKey,
        error: formatErrorMessage(error),
      }),
    };
  }
}
