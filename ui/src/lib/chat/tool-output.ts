import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { applyEdits, format } from "jsonc-parser";
import { parseMarkdownJson } from "../../components/markdown-json.ts";
import { t } from "../../i18n/index.ts";
import { registerChatToolLabelsEnglish } from "../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard } from "./chat-types.ts";

registerChatToolLabelsEnglish();

export const TOOL_OUTPUT_PREVIEW_CHARS = 8_000;

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

export function toolOutputSourceLabel(card: ToolCard): string {
  return t(
    card.toolOutput?.source === "provider-response"
      ? "chat.toolCards.providerResponse"
      : card.toolOutput?.source === "execution"
        ? "chat.toolCards.executionOutput"
        : "chat.toolCards.toolOutput",
  );
}

// Whitespace-only edits preserve duplicate members and exact number/string lexemes.
function formatJsonText(text: string): string {
  return parseMarkdownJson(text)?.root
    ? applyEdits(text, format(text, undefined, { insertSpaces: true, tabSize: 2 }))
    : text;
}

/** Format for display while preserving the captured bytes for Raw/Copy/Download. */
export function formatToolOutput(card: ToolCard): string | undefined {
  const text = card.outputText;
  if (text === undefined || card.preview) {
    return text;
  }
  // Tool results reach the model as compact JSON; indent them only for display.
  if (
    card.toolOutput?.source !== "provider-response" ||
    card.name !== "exec" ||
    !isRecord(card.args) ||
    typeof card.args.input !== "string"
  ) {
    return formatJsonText(text);
  }
  const parts = safeParseJson(text);
  if (
    !Array.isArray(parts) ||
    parts.length === 0 ||
    !parts.every(
      (part) => isRecord(part) && part.type === "input_text" && typeof part.text === "string",
    )
  ) {
    return formatJsonText(text);
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
      const formatted = formatJsonText(execution?.text ?? responseText);
      return execution && execution.exitCode !== 0
        ? `${t("chat.toolCards.exitCode", { code: String(execution.exitCode) })}\n${formatted}`
        : formatted;
    })
    .join("\n");
}
