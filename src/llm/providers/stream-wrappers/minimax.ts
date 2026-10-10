import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { StreamFn } from "../../../agents/runtime/index.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { streamSimple } from "../../stream.js";
import { resolveMinimaxFastModelId } from "../minimax-fast-mode.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

type DynamicFastMode = boolean | (() => boolean | undefined);

function isMinimaxAnthropicMessagesModel(model: { api?: unknown; provider?: unknown }): boolean {
  return (
    model.api === "anthropic-messages" &&
    (model.provider === "minimax" || model.provider === "minimax-portal")
  );
}

function isMinimaxM3Model(model: { id?: unknown }): boolean {
  const modelId = typeof model.id === "string" ? model.id.trim() : "";
  return /^MiniMax-M3(\b|[-.])/i.test(modelId);
}

function resolvePositiveMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
export function createMinimaxFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: DynamicFastMode,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if ((typeof fastMode === "function" ? fastMode() : fastMode) !== true) {
      return underlying(model, context, options);
    }

    const fastModelId = resolveMinimaxFastModelId(model);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

export function createMinimaxThinkingDisabledWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isMinimaxAnthropicMessagesModel(model)) {
      return underlying(model, context, options);
    }
    const isM3 = isMinimaxM3Model(model);

    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      if (isM3) {
        const thinkingType = asOptionalRecord(payload.thinking)?.type;
        if (thinkingLevel === undefined && thinkingType === "disabled") {
          // Leave an omitted control with the provider default; explicit off stays disabled.
          delete payload.thinking;
        } else if (
          thinkingLevel !== "off" &&
          (thinkingType === "enabled" || thinkingType === "disabled")
        ) {
          // M3 uses adaptive thinking; restore the caller's output cap after budget expansion.
          payload.thinking = { type: "adaptive" };
          const maxTokens = resolvePositiveMaxTokens(options?.maxTokens);
          if (maxTokens !== undefined) {
            payload.max_tokens = maxTokens;
          }
        }
      }
      // M2.x only needs the shim when no earlier wrapper set thinking.
      // Downstream payload hooks still run after this wrapper.
      if (!isM3 && payload.thinking === undefined) {
        payload.thinking = { type: "disabled" };
      }
    });
  };
}
