import { responsesServiceTierObserver } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "@openclaw/llm-core";
import type { ModelServiceTierObservation } from "../../../agents/prepared-model-runtime-auth.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { supportsOpenAIResponsesFastMode } from "../openai-fast-mode.js";

const log = createSubsystemLogger("llm/providers/stream-wrappers");

/** Fulfillment belongs to the selected account; it never changes the next request. */
export function createOpenAIServiceTierObservationWrapper(
  underlying: StreamFn,
  recordObservation: (
    model: Parameters<StreamFn>[0],
    observation: Pick<ModelServiceTierObservation, "requestedTier" | "responseTier">,
  ) => boolean,
  attribution: { runId: string; sessionId: string; accountRoute: string },
): StreamFn {
  return (model, context, options) => {
    if (model.api !== "openai-responses" || !supportsOpenAIResponsesFastMode(model)) {
      return underlying(model, context, options);
    }
    const observedOptions = { ...options };
    const previous = options && responsesServiceTierObserver.get(options);
    let rejectedTier: string | undefined;
    responsesServiceTierObserver.set(observedOptions, (observation) => {
      previous?.(observation);
      // A successful slower retry still describes the original rejected request.
      if (observation.rejected) {
        rejectedTier ??= observation.requestedTier;
      }
      const requestedTier = rejectedTier ?? observation.requestedTier;
      if (requestedTier !== "ultrafast" && requestedTier !== "priority") {
        return;
      }
      const responseTier = observation.rejected ? undefined : observation.responseTier;
      recordObservation(model, { requestedTier, responseTier });
      // Catalog changes are deduplicated; each fulfilled request still needs attribution.
      if (requestedTier !== responseTier) {
        log.info(
          `OpenAI ${requestedTier} requested; ${responseTier ? `served as ${responseTier}` : "rejected"} for the selected account/model route.`,
          {
            ...attribution,
            model: model.id,
            provider: model.provider,
            requestedTier,
            wireRequestedTier: observation.requestedTier,
            responseTier,
            requestId: options?.requestId,
            ...(!observation.rejected && {
              responseId: observation.responseId,
              responseModel: observation.responseModel,
              inputTokens: observation.inputTokens,
              cachedTokens: observation.cachedTokens,
            }),
          },
        );
      }
    });
    return underlying(model, context, observedOptions);
  };
}
