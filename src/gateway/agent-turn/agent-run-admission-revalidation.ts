import { ErrorCodes, type ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { errorShapeFromError } from "../error-shape.js";
import type { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { assertParentSubagentResumeCurrent } from "../session-subagent-resume.js";
import { setAbortedAgentDedupeEntries } from "./agent-dedupe.js";
import type { AgentTurnContext, AgentTurnPrincipal } from "./types.js";

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
