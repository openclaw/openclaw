import {
  isSessionDeliveryGenerationRevokedError,
  prepareSessionDeliveryGeneration,
} from "../../config/sessions/session-delivery-generation.js";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";

/** Translate session-owner decisions into the existing queue retry/terminal contract. */
export async function prepareOutboundDeliveryGeneration(generation: SessionDeliveryGeneration) {
  const notDispatched = (error: unknown): never => {
    throw new PlatformMessageNotDispatchedError(
      error instanceof Error ? error.message : "Session delivery generation is unavailable",
      { cause: error, retryable: !isSessionDeliveryGenerationRevokedError(error) },
    );
  };
  try {
    const prepared = await prepareSessionDeliveryGeneration(generation);
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
  } catch (error) {
    return notDispatched(error);
  }
}
