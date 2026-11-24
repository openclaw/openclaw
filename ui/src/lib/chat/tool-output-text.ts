import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { registerChatToolLabelsEnglish } from "../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard } from "./chat-types.ts";

registerChatToolLabelsEnglish();

export function isLegacyToolOutputUnavailable(card: ToolCard): boolean {
  // New records carry the producer's loss fact. Only older records need the
  // historical suffix; literal process text must never impersonate capture loss.
  return (
    !card.outputTruncated &&
    (card.toolOutput?.captureTruncated === true ||
      (!card.toolOutput &&
        /\n\.\.\.\(OpenClaw truncated Codex native tool output: original \d+ chars, showing \d+; rerun with narrower args\.\)\s*$/u.test(
          card.outputText ?? "",
        )))
  );
}

/** Unwrap native response envelopes without changing the captured text. */
export function readToolOutputText(
  card: ToolCard,
  formatText?: (text: string) => string,
): string | undefined {
  const text = card.outputText;
  if (
    text === undefined ||
    card.preview ||
    card.toolOutput?.source !== "provider-response" ||
    card.name !== "exec" ||
    !isRecord(card.args) ||
    typeof card.args.input !== "string"
  ) {
    return text;
  }
  const parts = safeParseJson(text);
  if (
    !Array.isArray(parts) ||
    parts.length === 0 ||
    !parts.every(
      (part) => isRecord(part) && part.type === "input_text" && typeof part.text === "string",
    )
  ) {
    return text;
  }
  return parts
    .filter(
      (part, index) =>
        index !== 0 ||
        parts.length === 1 ||
        !/^Script completed\nWall time [\d.]+ seconds\nOutput:\n$/u.test(part.text),
    )
    .map(({ text: responseText }) => {
      const value = safeParseJson(responseText);
      const execution =
        isRecord(value) &&
        typeof value.wall_time_seconds === "number" &&
        typeof value.exit_code === "number" &&
        typeof value.output === "string" &&
        Object.keys(value).every((key) =>
          ["chunk_id", "wall_time_seconds", "exit_code", "original_token_count", "output"].includes(
            key,
          ),
        )
          ? { text: value.output, exitCode: value.exit_code }
          : undefined;
      const output = execution?.text ?? responseText;
      const formatted = formatText?.(output) ?? output;
      return execution && execution.exitCode !== 0
        ? `${t("chat.toolCards.exitCode", { code: String(execution.exitCode) })}\n${formatted}`
        : formatted;
    })
    .join("\n");
}
