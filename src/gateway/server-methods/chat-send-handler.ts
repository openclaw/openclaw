import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import {
  retireProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import { handleChatSendWithStorage } from "./chat-send-input-dispatch.js";
import type { ChatSendInternalOptions } from "./chat-send-options.js";
import { runChatSendWithStorage } from "./chat-send-storage.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

async function handleChatSendWithOptions(
  handlerOptions: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
  options?: ChatSendInternalOptions,
): Promise<void> {
  await runChatSendWithStorage(handlerOptions, (storage) =>
    handleChatSendWithStorage(
      handlerOptions,
      onAdmissionOwned,
      externalAuthorityAdmission,
      options,
      storage,
    ),
  );
}

export async function handleChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, externalAuthorityAdmission);
}

/** The ordinary chat owner retains the exact human-reviewed continuation through settlement. */
export async function handleProviderReviewContinuationChat(
  options: GatewayRequestHandlerOptions,
  acknowledgment: ProviderReviewAcknowledgment,
): Promise<void> {
  let admissionOwned = false;
  try {
    await handleChatSendWithOptions(
      options,
      async () => {
        admissionOwned = true;
        return true;
      },
      undefined,
      { providerReviewAcknowledgment: acknowledgment },
    );
  } finally {
    if (!admissionOwned) {
      retireProviderReviewAcknowledgment(acknowledgment);
    }
  }
}

/** Operator Resume admits one hidden internal continuation with the Goal transition. */
export async function handleSessionGoalResumeChat(
  options: GatewayRequestHandlerOptions,
  operation: SessionGoalOperation & { action: "resume" },
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, { goalResume: operation });
}

/** Dispatches Gateway-authored system input without widening the public chat-send contract. */
export async function handleTrustedInternalChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  inputOptions?: Pick<
    ChatSendInternalOptions,
    "transcript" | "toolsAllow" | "prepareAssistantTranscriptMessage" | "beforeDispatch"
  >,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, undefined, {
    ...inputOptions,
    trustedSystemInput: true,
  });
}
