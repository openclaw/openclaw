import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { redactSensitiveText } from "../../logging/redact.js";
import type { PluginHookInputRouteEvent } from "../../plugins/hook-types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../../shared/text/assistant-visible-text.js";

const AUTO_STEER_MAX_INPUT_CHARS = 8_000;
const AUTO_STEER_MAX_CONTEXT_CHARS = 12_000;

/** Project only already-authorized display rows; never return their metadata to a plugin. */
export function projectAutoSteerEvidence(
  messages: readonly unknown[],
  sourceTurnId: string,
  newMessage: string,
): PluginHookInputRouteEvent | undefined {
  const sourceKey = sourceTurnId + ":user";
  const sourceIndex = messages.findIndex((value) => {
    const message = asOptionalRecord(value);
    return (
      message?.role === "user" &&
      (message.idempotencyKey === sourceKey ||
        asOptionalRecord(message["__openclaw"])?.idempotencyKey === sourceKey)
    );
  });
  if (sourceIndex < 0) {
    return undefined;
  }
  const currentTurn: { role: "user" | "assistant"; text: string }[] = [];
  let remaining = AUTO_STEER_MAX_CONTEXT_CHARS;
  for (let index = sourceIndex; index < messages.length; index++) {
    const message = asOptionalRecord(messages[index]);
    const meta = asOptionalRecord(message?.["__openclaw"]);
    if (
      !message ||
      message.display === false ||
      message.excludeFromContext === true ||
      (message.role !== "user" && message.role !== "assistant") ||
      message.provenance ||
      meta?.workContext ||
      meta?.replyToId ||
      meta?.media
    ) {
      if (index === sourceIndex) {
        return undefined;
      }
      continue;
    }
    const raw =
      extractTextFromChatContent(message.content, {
        joinWith: "\n",
        normalizeText: (text) => text,
      }) ?? "";
    const text = redactSensitiveText(
      message.role === "assistant" ? sanitizeAssistantVisibleTextWithProfile(raw, "history") : raw,
      { mode: "tools" },
    );
    if (!text || text.length > remaining) {
      if (index === sourceIndex) {
        return undefined;
      }
      continue;
    }
    currentTurn.push({ role: message.role, text });
    remaining -= text.length;
  }
  const redactedInput = redactSensitiveText(newMessage, { mode: "tools" });
  return currentTurn.length && redactedInput.length <= AUTO_STEER_MAX_INPUT_CHARS
    ? { currentTurn, newMessage: redactedInput }
    : undefined;
}
