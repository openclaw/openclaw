import { responsesServiceTierObserver } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ModelServiceTierObservation } from "../../../agents/prepared-model-runtime-auth.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { supportsOpenAIResponsesFastMode } from "../openai-fast-mode.js";

const log = createSubsystemLogger("llm/providers/stream-wrappers");

type TierRecovery = { rejections: number; until: number; remaining: number };
// Worker calls rebuild their wrapper; the registered run owns the shared lifetime.
const runRecoveries = new WeakMap<object, Map<string, TierRecovery>>();

/** Account observations remain hints; explicit rejections also cool down this run. */
export function createOpenAIServiceTierObservationWrapper(
  underlying: StreamFn,
  recordObservation: (
    model: Parameters<StreamFn>[0],
    observation: Pick<ModelServiceTierObservation, "requestedTier" | "responseTier">,
  ) => boolean,
  attribution: { runId: string; sessionId: string; accountRoute: string },
): StreamFn {
  const run = getAgentRunContext(attribution.runId);
  const recoveries = (run && runRecoveries.get(run)) ?? new Map<string, TierRecovery>();
  if (run) {
    runRecoveries.set(run, recoveries);
  }
  return (model, context, options) => {
    if (model.api !== "openai-responses" || !supportsOpenAIResponsesFastMode(model)) {
      return underlying(model, context, options);
    }
    const route = JSON.stringify([attribution.accountRoute, model.id, model.api, model.baseUrl]);
    let recovery = recoveries.get(route);
    if (!recovery) {
      recovery = { rejections: 0, until: 0, remaining: 0 };
      recoveries.set(route, recovery);
    }
    let rejectedTier: string | undefined;
    const observedOptions = { ...options };
    if (recovery.remaining > 0 && Date.now() < recovery.until) {
      recovery.remaining--;
      observedOptions.onPayload = async (payload, payloadModel) => {
        const replacement = await options?.onPayload?.(payload, payloadModel);
        const request = replacement ?? payload;
        if (isRecord(request) && request.service_tier === "ultrafast") {
          rejectedTier = "ultrafast";
          request.service_tier = "priority";
        }
        return replacement;
      };
    }
    const previous = options && responsesServiceTierObserver.get(options);
    responsesServiceTierObserver.set(observedOptions, (observation) => {
      previous?.(observation);
      if (!options?.signal?.aborted && observation.requestedTier === "ultrafast") {
        if (observation.rejected) {
          recovery.rejections++;
          if (recovery.rejections >= 2) {
            recovery.until = Date.now() + 10 * 60_000;
            recovery.remaining = 20;
          }
        } else {
          recovery.rejections = 0;
          recovery.until = 0;
          recovery.remaining = 0;
        }
      }
      // Retain the selected tier across both recovery retries and cooldown calls.
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
