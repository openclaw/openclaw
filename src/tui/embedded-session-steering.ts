import type { SessionEntry } from "../config/sessions/types.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import {
  steerSessionControllerOperation,
  type SessionControllerSteerResult,
} from "../sessions/session-controller.steer.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";

/** Prepare the local ingress caller independently of the active turn's authority. */
export function steerEmbeddedSessionInput(params: {
  operation: ReplyOperation | undefined;
  text: string;
  sessionEntry?: SessionEntry;
  debounceMs: number;
  abortSignal: AbortSignal;
}): Promise<SessionControllerSteerResult> {
  const { sessionEntry, abortSignal } = params;
  return steerSessionControllerOperation({
    operation: params.operation,
    text: params.text,
    options: {
      steeringMode: "all",
      debounceMs: params.debounceMs,
      isInboundUserMessage: true,
      abortSignal,
      assertCurrent: () => abortSignal.throwIfAborted(),
      toolAuthorityOverlay: {
        originatingChannel: INTERNAL_MESSAGE_CHANNEL,
        messageProvider: INTERNAL_MESSAGE_CHANNEL,
        permissionMode: sessionEntry?.permissionMode,
        toolOverrides: sessionEntry?.toolOverrides,
        chatType: sessionEntry?.chatType,
        spawnedBy: sessionEntry?.spawnedBy,
        // Match agentCommandFromIngress and its prepared embedded tool authority.
        senderIsOwner: false,
        traceAuthorized: false,
        disableTools: false,
      },
    },
  });
}
