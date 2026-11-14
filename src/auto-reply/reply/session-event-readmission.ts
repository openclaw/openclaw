import { setTimeout as delay } from "node:timers/promises";
import { classifySessionDeliveryGenerationRefusal } from "../../config/sessions/session-delivery-generation-errors.js";

/** Policy publications or lease refusals an occurrence may outlive before it settles as failed. */
export const MAX_READMISSION_ATTEMPTS = 2;

/**
 * Producers never retry, so a policy publication or an unavailable session lease that rejected
 * an unstarted occurrence re-admits it under fresh authority instead of destroying it.
 * A revoked lease, like Stop, abort and other abandonment, still settles terminally.
 */
export function createSessionEventReadmission(
  configPolicy: { readonly changed: boolean },
  attempt: number,
) {
  // Only errors that ended this attempt count: Stop can abandon a wake whose lease also failed.
  let refusal: "unavailable" | "revoked" | undefined;
  const rejects = (...errors: unknown[]) => {
    for (const error of errors) {
      if (refusal !== "revoked") {
        refusal = classifySessionDeliveryGenerationRefusal(error) ?? refusal;
      }
    }
    return configPolicy.changed || refusal === "unavailable";
  };
  return {
    /** Notes these errors, then reports a policy change or a noted unavailable-lease refusal. */
    rejects,
    /** A rejected adoption surfaces only as abandonment, which keeps no error; note its cause. */
    async adopt(adoption: () => Promise<void>) {
      try {
        await adoption();
      } catch (error) {
        rejects(error);
        throw error;
      }
    },
    /** Yields before fresh authority; an abort during the wait settles normally. */
    async backoff(signal: AbortSignal) {
      await delay(100 * 2 ** attempt, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) {
          throw error;
        }
      });
    },
  };
}
