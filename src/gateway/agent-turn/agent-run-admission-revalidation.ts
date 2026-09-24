import { ErrorCodes, type ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import type { PreparedModelRuntimeLease } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { errorShapeFromError } from "../error-shape.js";
import type { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { assertParentSubagentResumeCurrent } from "../session-subagent-resume.js";
import { setAbortedAgentDedupeEntries } from "./agent-dedupe.js";
import type { PreparedAgentRunDispatch } from "./agent-run-admission-types.js";
import {
  settleUnstartedGatewayAgentTask,
  type RegisteredGatewayAgentTask,
} from "./agent-run-task-tracking.js";
import type { AgentTurnContext, AgentTurnPrincipal } from "./types.js";

/** Settle a rejected admission before releasing its runtime, ordering, and caller owners. */
export async function cleanupRejectedAgentRunAdmission(
  params: Pick<
    PreparedAgentRunDispatch,
    "activeGatewayWorkAdmission" | "activeRunAbort" | "executionOrder" | "releaseCallerAuthority"
  > & {
    preparedModelRuntimeLease?: PreparedModelRuntimeLease;
    registeredFollowupTask?: RegisteredGatewayAgentTask;
    context: AgentTurnContext;
    runId: string;
    admissionReleased?: boolean;
    failure?: string;
  },
): Promise<void> {
  const { activeRunAbort } = params;
  try {
    if (params.registeredFollowupTask) {
      await settleUnstartedGatewayAgentTask({
        tracking: params.registeredFollowupTask,
        runId: params.runId,
        admittedRunEntry: activeRunAbort.entry,
        context: params.context,
        outcome: buildAgentRunTerminalOutcome({
          status: activeRunAbort.controller.signal.aborted ? "timeout" : "error",
          stopReason: activeRunAbort.controller.signal.aborted
            ? (activeRunAbort.entry?.abortStopReason ?? "rpc")
            : undefined,
          error: params.failure ?? "Follow-up admission ended before acceptance.",
        }),
      });
    }
  } finally {
    try {
      await params.preparedModelRuntimeLease?.[Symbol.asyncDispose]();
    } finally {
      params.executionOrder?.release();
      params.releaseCallerAuthority?.();
      activeRunAbort.cleanup();
      if (!params.admissionReleased) {
        params.activeGatewayWorkAdmission.release();
      }
    }
  }
}

/** Revalidate the same prepared admission after each asynchronous preparation step. */
export function createAgentRunAdmissionRevalidator(options: {
  source: {
    context: AgentTurnContext;
    agentDedupeKeys: readonly string[];
    admissionAgentId: () => string | undefined;
    runId: string;
    assertGatewayWorkAdmissionAllowed: () => void;
    client: AgentTurnPrincipal | null;
    cfg: OpenClawConfig;
    resolvedSessionKey?: string;
    getAdmittedSessionId: () => string;
    respondToGatewayAdmissionOutcome: () => boolean;
  };
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  parentResume: ReturnType<typeof readInProcessSubagentResume>;
  rejectPreaccept: (error: ErrorShape) => Promise<undefined>;
  cleanupPreaccept: (admissionReleased?: boolean) => Promise<void>;
}) {
  const {
    source: params,
    activeRunAbort,
    parentResume,
    rejectPreaccept,
    cleanupPreaccept,
  } = options;
  return (): true | Promise<undefined> => {
    if (activeRunAbort.controller.signal.aborted) {
      setAbortedAgentDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.agentDedupeKeys,
        agentId: params.admissionAgentId(),
        runId: params.runId,
        stopReason: activeRunAbort.entry?.abortStopReason ?? "rpc",
      });
    }
    try {
      params.assertGatewayWorkAdmissionAllowed();
      if (parentResume) {
        if (params.client?.internal?.syntheticClient !== true) {
          throw new Error("Task resume requires trusted in-process admission.");
        }
        assertParentSubagentResumeCurrent({
          cfg: params.cfg,
          resume: parentResume,
          sessionKey: params.resolvedSessionKey,
          sessionId: params.getAdmittedSessionId(),
        });
      }
    } catch (err) {
      return rejectPreaccept(errorShapeFromError(ErrorCodes.INVALID_REQUEST, err));
    }
    if (!params.respondToGatewayAdmissionOutcome()) {
      return true;
    }
    return cleanupPreaccept(true).then(() => undefined);
  };
}
