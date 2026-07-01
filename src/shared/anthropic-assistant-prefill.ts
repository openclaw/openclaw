import type { Context, Model } from "../llm/types.js";
import { resolveClaudeSonnet5ModelIdentity } from "./anthropic-model-contract.js";

/** Remove Sonnet 5 assistant prefills while preserving completed tool-use turns. */
export function prepareClaudeSonnet5RequestContext(model: Model, context: Context): Context {
  if (!resolveClaudeSonnet5ModelIdentity(model)) {
    return context;
  }

  let end = context.messages.length;
  while (end > 0) {
    const message = context.messages[end - 1];
    if (
      message?.role !== "assistant" ||
      (Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall"))
    ) {
      break;
    }
    end -= 1;
  }
  return end === context.messages.length
    ? context
    : { ...context, messages: context.messages.slice(0, end) };
}
