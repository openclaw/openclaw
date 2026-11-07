import { stripThinkingTags } from "../strip-thinking-tags.ts";

type TextConsumer = "narration" | "display";
type StrippedText = { source: string; result: string };
const strippedText = new WeakMap<object, Partial<Record<TextConsumer, StrippedText>>>();

/** Share exact inputs without conflating raw narration with runtime-stripped display text. */
export function stripAssistantMessageText(
  message: unknown,
  source: string,
  consumer: TextConsumer,
): string {
  if (!message || typeof message !== "object") {
    return stripThinkingTags(source);
  }
  const cached = strippedText.get(message) ?? {};
  const own = cached[consumer];
  if (own?.source === source) {
    return own.result;
  }
  const sibling = cached[consumer === "narration" ? "display" : "narration"];
  const result = sibling?.source === source ? sibling.result : stripThinkingTags(source);
  cached[consumer] = { source, result };
  strippedText.set(message, cached);
  return result;
}
