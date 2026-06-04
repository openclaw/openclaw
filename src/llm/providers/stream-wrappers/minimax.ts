// MiniMax stream wrapper normalizes MiniMax streamed text and reasoning output.
import type { StreamFn } from "../../../agents/runtime/index.js";
import { streamSimple } from "../../stream.js";

const MINIMAX_FAST_MODEL_IDS = new Map<string, string>([
  ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
]);

function resolveMinimaxFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return MINIMAX_FAST_MODEL_IDS.get(modelId.trim());
}

function isMinimaxAnthropicMessagesModel(model: { api?: unknown; provider?: unknown }): boolean {
  return (
    model.api === "anthropic-messages" &&
    (model.provider === "minimax" || model.provider === "minimax-portal")
  );
}

/**
 * MiniMax-M3 (and any forward-compatible MiniMax-M3.x successor) emits proper
 * Anthropic-shape thinking blocks (`content_block_start` with `type:"thinking"`
 * + `thinking_delta`) and **requires** thinking to be active to produce any
 * visible text. Pinning `thinking: { type: "disabled" }` on M3 makes the model
 * return an empty content array with `stop_reason: "end_turn"` and 1 output
 * token — observed against `https://api.minimax.io/anthropic/v1/messages`.
 *
 * The legacy MiniMax-M2.x family still needs the disable-thinking shim
 * because their Anthropic-compat streams leak `reasoning_content` in
 * OpenAI-style deltas (see {@link createMinimaxThinkingDisabledWrapper}).
 */
function isMinimaxModelRequiringThinking(model: { id?: unknown }): boolean {
  const modelId = typeof model.id === "string" ? model.id.trim() : "";
  return /^MiniMax-M3(\b|[-.])/i.test(modelId);
}

/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
export function createMinimaxFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      !fastMode ||
      model.api !== "anthropic-messages" ||
      (model.provider !== "minimax" && model.provider !== "minimax-portal")
    ) {
      return underlying(model, context, options);
    }

    const fastModelId = resolveMinimaxFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

/**
 * Legacy MiniMax (M2.x) Anthropic-compatible streaming endpoint returns
 * reasoning_content in OpenAI-style delta chunks ({delta: {content: "",
 * reasoning_content: "..."}}) rather than the native Anthropic thinking
 * block format. The shared Anthropic provider cannot process this format
 * and leaks the reasoning text as visible content. Disable thinking in the
 * outgoing payload so MiniMax does not produce reasoning_content deltas
 * during streaming.
 *
 * **Skipped for MiniMax-M3+**, which emits proper Anthropic-shape thinking
 * blocks and requires thinking enabled to produce any visible content.
 * Disabling thinking on M3 causes the model to return an empty content
 * array with `stop_reason: "end_turn"` and 1 output token. See
 * {@link isMinimaxModelRequiringThinking}.
 */
/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
export function createMinimaxThinkingDisabledWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isMinimaxAnthropicMessagesModel(model)) {
      return underlying(model, context, options);
    }
    if (isMinimaxModelRequiringThinking(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          // Only inject if thinking is not already explicitly set.
          // This preserves unknown intentional override from other wrappers.
          if (payloadObj.thinking === undefined) {
            payloadObj.thinking = { type: "disabled" };
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
