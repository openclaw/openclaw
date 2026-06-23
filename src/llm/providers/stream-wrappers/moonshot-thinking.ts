// Moonshot thinking wrapper normalizes reasoning output from Moonshot streams.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { StreamFn } from "../../../agents/runtime/index.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";

type MoonshotThinkingType = "enabled" | "disabled";
type MoonshotThinkingKeep = "all";
const MOONSHOT_THINKING_KEEP_MODEL_ID = "kimi-k2.6";
const MOONSHOT_ALWAYS_THINKING_MODEL_ID = "kimi-k2.7-code";
const MOONSHOT_FIXED_SAMPLING_FIELDS = [
  "temperature",
  "top_p",
  "n",
  "presence_penalty",
  "frequency_penalty",
] as const;
const llmRuntimeLoader = createLazyImportLoader(() => import("openclaw/plugin-sdk/llm"));

async function loadDefaultStreamFn(): Promise<StreamFn> {
  const runtime = await llmRuntimeLoader.load();
  return runtime.streamSimple;
}

function normalizeMoonshotThinkingType(value: unknown): MoonshotThinkingType | undefined {
  if (typeof value === "boolean") {
    return value ? "enabled" : "disabled";
  }
  if (typeof value === "string") {
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized) {
      return undefined;
    }
    if (["enabled", "enable", "on", "true"].includes(normalized)) {
      return "enabled";
    }
    if (["disabled", "disable", "off", "false"].includes(normalized)) {
      return "disabled";
    }
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeMoonshotThinkingType((value as Record<string, unknown>).type);
  }
  return undefined;
}

function normalizeMoonshotThinkingKeep(value: unknown): MoonshotThinkingKeep | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const keepValue = (value as Record<string, unknown>).keep;
  if (typeof keepValue !== "string") {
    return undefined;
  }
  return normalizeOptionalLowercaseString(keepValue) === "all" ? "all" : undefined;
}

function isMoonshotToolChoiceCompatible(toolChoice: unknown): boolean {
  if (toolChoice == null || toolChoice === "auto" || toolChoice === "none") {
    return true;
  }
  if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const typeValue = (toolChoice as Record<string, unknown>).type;
    return typeValue === "auto" || typeValue === "none";
  }
  return false;
}

function isPinnedToolChoice(toolChoice: unknown): boolean {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return false;
  }
  const typeValue = (toolChoice as Record<string, unknown>).type;
  return typeValue === "tool" || typeValue === "function";
}

function asPayloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ensureMoonshotToolCallReasoningContent(payloadObj: Record<string, unknown>): void {
  if (!Array.isArray(payloadObj.messages)) {
    return;
  }
  for (const message of payloadObj.messages) {
    const record = asPayloadRecord(message);
    if (
      record?.role === "assistant" &&
      Array.isArray(record.tool_calls) &&
      record.tool_calls.length > 0 &&
      !("reasoning_content" in record)
    ) {
      record.reasoning_content = "";
    }
  }
}

function sanitizeKimiK27Payload(payloadObj: Record<string, unknown>): void {
  delete payloadObj.thinking;
  delete payloadObj.reasoning_effort;
  delete payloadObj.reasoningEffort;
  for (const field of MOONSHOT_FIXED_SAMPLING_FIELDS) {
    delete payloadObj[field];
  }
  if (!isMoonshotToolChoiceCompatible(payloadObj.tool_choice)) {
    payloadObj.tool_choice = "auto";
  }
}

function sanitizeKimiK27AfterCaller(
  value: unknown,
  fallbackPayload: Record<string, unknown>,
): unknown {
  const finalPayload = asPayloadRecord(value) ?? fallbackPayload;
  sanitizeKimiK27Payload(finalPayload);
  ensureMoonshotToolCallReasoningContent(finalPayload);
  return value;
}

function finalizeMoonshotPayloadAfterCaller(
  value: unknown,
  fallbackPayload: Record<string, unknown>,
  thinkingEnabled: boolean,
): unknown {
  if (thinkingEnabled) {
    ensureMoonshotToolCallReasoningContent(asPayloadRecord(value) ?? fallbackPayload);
  }
  return value;
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function resolveMoonshotThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined {
  const configured = normalizeMoonshotThinkingType(params.configuredThinking);
  if (configured) {
    return configured;
  }
  if (!params.thinkingLevel) {
    return undefined;
  }
  return params.thinkingLevel === "off" ? "disabled" : "enabled";
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function resolveMoonshotThinkingKeep(params: {
  configuredThinking: unknown;
}): MoonshotThinkingKeep | undefined {
  return normalizeMoonshotThinkingKeep(params.configuredThinking);
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function createMoonshotThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingType?: MoonshotThinkingType,
  thinkingKeep?: MoonshotThinkingKeep,
): StreamFn {
  const wrap =
    (underlying: StreamFn): StreamFn =>
    (model, context, options) => {
      const modelId = model.id.trim().toLowerCase();
      const isKimiK27 = modelId === MOONSHOT_ALWAYS_THINKING_MODEL_ID;
      const streamModel = isKimiK27 ? { ...model, reasoning: true } : model;
      const streamOptions = isKimiK27 ? { ...options, reasoning: "low" as const } : options;
      const originalOnPayload = streamOptions?.onPayload;
      return underlying(streamModel, context, {
        ...streamOptions,
        onPayload(payload, payloadModel) {
          const payloadObj = asPayloadRecord(payload);
          if (!payloadObj) {
            return originalOnPayload?.(payload, payloadModel);
          }
          const payloadModelId =
            typeof payloadObj.model === "string" ? payloadObj.model.trim().toLowerCase() : modelId;
          let effectiveThinkingType = normalizeMoonshotThinkingType(payloadObj.thinking);

          if (thinkingType) {
            payloadObj.thinking = { type: thinkingType };
            effectiveThinkingType = thinkingType;
          }

          if (payloadModelId === MOONSHOT_ALWAYS_THINKING_MODEL_ID) {
            // K2.7 Code always reasons, preserves reasoning, and fixes sampling.
            // Reapply constraints after caller hooks so extra_body cannot restore them.
            sanitizeKimiK27Payload(payloadObj);
            const result = originalOnPayload?.(payload, payloadModel);
            if (result && typeof (result as Promise<unknown>).then === "function") {
              return Promise.resolve(result).then((resolved) =>
                sanitizeKimiK27AfterCaller(resolved, payloadObj),
              );
            }
            return sanitizeKimiK27AfterCaller(result, payloadObj);
          }

          if (
            effectiveThinkingType === "enabled" &&
            !isMoonshotToolChoiceCompatible(payloadObj.tool_choice)
          ) {
            if (payloadObj.tool_choice === "required") {
              payloadObj.tool_choice = "auto";
            } else if (isPinnedToolChoice(payloadObj.tool_choice)) {
              payloadObj.thinking = { type: "disabled" };
              effectiveThinkingType = "disabled";
            }
          }

          // thinking.keep is only valid on kimi-k2.6 when thinking is enabled. Gate
          // by the final payload.model and final type so stray config never leaks.
          const isKeepCapableModel = payloadModelId === MOONSHOT_THINKING_KEEP_MODEL_ID;
          if (payloadObj.thinking && typeof payloadObj.thinking === "object") {
            const thinkingObj = payloadObj.thinking as Record<string, unknown>;
            if (
              isKeepCapableModel &&
              effectiveThinkingType === "enabled" &&
              thinkingKeep === "all"
            ) {
              thinkingObj.keep = "all";
            } else if ("keep" in thinkingObj) {
              delete thinkingObj.keep;
            }
          }
          const result = originalOnPayload?.(payload, payloadModel);
          const thinkingEnabled = effectiveThinkingType === "enabled";
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return Promise.resolve(result).then((resolved) =>
              finalizeMoonshotPayloadAfterCaller(resolved, payloadObj, thinkingEnabled),
            );
          }
          return finalizeMoonshotPayloadAfterCaller(result, payloadObj, thinkingEnabled);
        },
      });
    };
  if (baseStreamFn) {
    return wrap(baseStreamFn);
  }
  return async (model, context, options) => {
    const underlying = await loadDefaultStreamFn();
    return wrap(underlying)(model, context, options);
  };
}
