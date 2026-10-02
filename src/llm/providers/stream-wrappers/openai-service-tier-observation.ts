import { responsesServiceTierObserver } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "@openclaw/llm-core";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { supportsOpenAIResponsesFastMode } from "../openai-fast-mode.js";

const log = createSubsystemLogger("llm/providers/stream-wrappers");

/** Carry a provider echo back to the selected account's catalog observation owner. */
export function createOpenAIServiceTierObservationWrapper(
  underlying: StreamFn,
  recordDowngrade: (model: Parameters<StreamFn>[0]) => boolean,
): StreamFn {
  return (model, context, options) => {
    if (model.api !== "openai-responses" || !supportsOpenAIResponsesFastMode(model)) {
      return underlying(model, context, options);
    }
    const observedOptions = { ...options };
    const previous = options && responsesServiceTierObserver.get(options);
    responsesServiceTierObserver.set(observedOptions, (observation) => {
      previous?.(observation);
      if (
        observation.requestedTier === "ultrafast" &&
        observation.responseTier !== "ultrafast" &&
        recordDowngrade(model)
      ) {
        log.info(
          "OpenAI downgraded an Ultrafast request; the account's model route now offers Fast.",
        );
      }
    });
    return underlying(model, context, observedOptions);
  };
}
