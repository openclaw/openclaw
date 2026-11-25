import { applyEdits, format } from "jsonc-parser";
import { parseMarkdownJson } from "../../components/markdown-json.ts";
import { t } from "../../i18n/index.ts";
import type { ToolCard } from "./chat-types.ts";
import { readToolOutputText } from "./tool-output-text.ts";

export const TOOL_OUTPUT_PREVIEW_CHARS = 8_000;

export function toolOutputSourceLabel(card: ToolCard): string {
  return t(
    card.toolOutput?.source === "provider-response"
      ? "chat.toolCards.providerResponse"
      : card.toolOutput?.source === "execution"
        ? "chat.toolCards.executionOutput"
        : "chat.toolCards.toolOutput",
  );
}

/** Format for display while preserving the captured bytes for Raw/Copy/Download. */
export function formatToolOutput(card: ToolCard): string | undefined {
  return readToolOutputText(card, (output) =>
    // Whitespace-only edits preserve duplicate members and exact number/string lexemes.
    parseMarkdownJson(output)?.root
      ? applyEdits(output, format(output, undefined, { insertSpaces: true, tabSize: 2 }))
      : output,
  );
}
