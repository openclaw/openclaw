import {
  isSessionDeliveryGenerationRevokedError,
  prepareChatDeliveryLease,
} from "../../config/sessions/session-delivery-generation.js";
import { chatRef, type ChatRef } from "../../sessions/chat-ref.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";

/** Translate session-owner decisions into the existing queue retry/terminal contract. */
export async function prepareOutboundDeliveryGeneration(chat: ChatRef) {
  const notDispatched = (error: unknown): never => {
    throw new PlatformMessageNotDispatchedError(
      error instanceof Error ? error.message : "Session delivery generation is unavailable",
      { cause: error, retryable: !isSessionDeliveryGenerationRevokedError(error) },
    );
  };
  // Rows queued by older builds also carry transcript ids; the chat key alone addresses it.
  const prepared = await prepareChatDeliveryLease(chatRef(chat)).catch(notDispatched);
  return {
    assertCurrent() {
      try {
        prepared.assertCurrent();
      } catch (error) {
        notDispatched(error);
      }
    },
    release: prepared.release,
  };
}
