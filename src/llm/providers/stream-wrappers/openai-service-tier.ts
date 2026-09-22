import { resolveOpenAIResponsesPayloadPolicy } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import type { StreamFn } from "../../../agents/runtime/index.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { streamSimple } from "../../stream.js";
import {
  normalizeOpenAIServiceTier,
  supportsOpenAIResponsesFastMode,
  type OpenAIServiceTier,
} from "../openai-fast-mode.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

const log = createSubsystemLogger("llm/providers/stream-wrappers");
type DynamicFastMode = boolean | (() => boolean | undefined);

function shouldApplyOpenAIServiceTier(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  return resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" }).allowsServiceTier;
}

/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export function resolveOpenAIServiceTier(
  extraParams: Record<string, unknown> | undefined,
): OpenAIServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  const normalized = normalizeOpenAIServiceTier(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI service tier param: ${rawSummary}`);
  }
  return normalized;
}

function normalizeOpenAIFastMode(value: unknown): boolean | undefined {
  if (typeof value === "function") {
    // SAFETY: Fast callbacks take no arguments; their result is normalized as unknown.
    return normalizeOpenAIFastMode((value as () => unknown)());
  }
  const fastMode = normalizeFastMode(value);
  return fastMode === "auto" ? undefined : fastMode;
}

/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export function resolveOpenAIFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  const normalized = normalizeOpenAIFastMode(raw);
  if (
    raw !== undefined &&
    normalized === undefined &&
    typeof raw !== "function" &&
    normalizeFastMode(raw) !== "auto"
  ) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI fast mode param: ${rawSummary}`);
  }
  return normalized;
}

function applyOpenAIFastModePayloadOverrides(params: {
  payloadObj: Record<string, unknown>;
  model: { provider?: unknown; id?: unknown; baseUrl?: unknown; api?: unknown };
}): void {
  if (params.payloadObj.service_tier === undefined && shouldApplyOpenAIServiceTier(params.model)) {
    params.payloadObj.service_tier = "priority";
  }
}

/** Shared tier precedence for native and explicitly compatible Responses routes. */
export function createOpenAIResponsesServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
): StreamFn {
  const serviceTier = resolveOpenAIServiceTier(extraParams);
  if (serviceTier) {
    return createOpenAIServiceTierWrapper(baseStreamFn, serviceTier);
  }
  if (
    extraParams &&
    (Object.hasOwn(extraParams, "fastMode") || Object.hasOwn(extraParams, "fast_mode"))
  ) {
    return createOpenAIFastModeWrapper(baseStreamFn, () => resolveOpenAIFastMode(extraParams));
  }
  return baseStreamFn ?? streamSimple;
}

/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export function createOpenAIFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: DynamicFastMode = true,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (normalizeOpenAIFastMode(enabled) !== true || !supportsOpenAIResponsesFastMode(model)) {
      return underlying(model, context, options);
    }
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (isRecord(payload)) {
          applyOpenAIFastModePayloadOverrides({
            payloadObj: payload,
            model,
          });
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export function createOpenAIServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: OpenAIServiceTier,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldApplyOpenAIServiceTier(model)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.service_tier === undefined) {
        payloadObj.service_tier = serviceTier;
      }
    });
  };
}
