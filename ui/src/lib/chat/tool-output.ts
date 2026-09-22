import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { applyEdits, format } from "jsonc-parser";
import { parseMarkdownJson } from "../../components/markdown-json.ts";
import { t } from "../../i18n/index.ts";
import type { ToolCard } from "./chat-types.ts";

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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatResponseText(text: string): string {
  const value = parseJson(text);
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
  const output = execution?.text ?? text;
  // Whitespace-only edits preserve duplicate members and exact number/string lexemes.
  const formatted = parseMarkdownJson(output)?.root
    ? applyEdits(output, format(output, undefined, { insertSpaces: true, tabSize: 2 }))
    : output;
  return execution && execution.exitCode !== 0
    ? `${t("chat.toolCards.exitCode", { code: String(execution.exitCode) })}\n${formatted}`
    : formatted;
}

/** Format for display while preserving the captured bytes for Raw/Copy/Download. */
export function formatToolOutput(card: ToolCard): string | undefined {
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
  const parts = parseJson(text);
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
    .map((part) => formatResponseText(part.text))
    .join("\n");
}
