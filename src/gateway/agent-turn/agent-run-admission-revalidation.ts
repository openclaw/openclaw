import { ErrorCodes, type ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { errorShapeFromError } from "../error-shape.js";
import type { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { assertParentSubagentResumeCurrent } from "../session-subagent-resume.js";
import { formatForLog } from "../ws-log.js";
import { setAbortedAgentDedupeEntries } from "./agent-dedupe.js";
import {
  releasePreparedAgentRunUserTurn,
  releasePreparedAgentRunUserTurnAfterFailure,
  type PreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";
import type { AgentTurnContext, AgentTurnPrincipal } from "./types.js";

/** Keep owner-provided policy failures intact across every preaccept preparation phase. */
export function resolveAgentRunAdmissionError(
  code: Parameters<typeof errorShapeFromError>[0],
  error: unknown,
): ErrorShape {
  return error instanceof SessionMutationAuthorizationChangedError
    ? error.error
    : errorShapeFromError(code, error);
}

/** Join rejected input and preaccept cleanup without losing either failure. */
export async function releaseFailedAgentRunAdmission(
  userTurn: PreparedAgentRunUserTurn,
  error: unknown,
  cleanupPreaccept: () => Promise<void>,
): Promise<never> {
  const failure = await releasePreparedAgentRunUserTurnAfterFailure(userTurn, error, "interrupted");
  try {
    await cleanupPreaccept();
  } catch (cleanupError) {
    throw new AggregateError(
      [failure, cleanupError],
      `${formatForLog(failure)}; agent admission cleanup failed: ${formatForLog(cleanupError)}`,
      { cause: cleanupError },
    );
  }
  throw failure;
}

/** Revalidate the same prepared admission after each asynchronous preparation step. */
export function createAgentRunAdmissionRevalidator(options: {
  source: {
    context: AgentTurnContext;
    getOwnedAgentDedupeKeys: () => readonly string[];
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
  const revalidate = (): true | Promise<undefined> => {
    if (activeRunAbort.controller.signal.aborted) {
      setAbortedAgentDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.getOwnedAgentDedupeKeys(),
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
      return rejectPreaccept(resolveAgentRunAdmissionError(ErrorCodes.INVALID_REQUEST, err));
    }
    if (!params.respondToGatewayAdmissionOutcome()) {
      return true;
    }
    return cleanupPreaccept(true).then(() => undefined);
  };
  return (userTurn?: PreparedAgentRunUserTurn): true | Promise<undefined> => {
    const result = revalidate();
    if (result === true || !userTurn) {
      return result;
    }
    return (async () => {
      try {
        return await result;
      } finally {
        await releasePreparedAgentRunUserTurn(userTurn, "interrupted");
      }
    })();
  };
}
