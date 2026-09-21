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

export function toolOutputSourceNote(card: ToolCard): string | undefined {
  return card.toolOutput
    ? t(
        card.toolOutput.source === "provider-response"
          ? "chat.toolCards.providerResponseNote"
          : "chat.toolCards.executionOutputNote",
      )
    : undefined;
}
