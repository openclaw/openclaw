import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { stripAnsi } from "../../../../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../../../../packages/terminal-core/src/safe-text.js";
import { t } from "../../../i18n/index.ts";
import { redactToolPayloadText } from "../../../lib/browser-redact.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { isToolCardError } from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";

function failureExcerpt(output: string | undefined): string | undefined {
  if (!output?.trim()) {
    return undefined;
  }
  let text = output;
  try {
    const record = asNullableRecord(JSON.parse(output));
    if (record) {
      text =
        readNonBlankString(record.error) ??
        readNonBlankString(record.message) ??
        readNonBlankString(asNullableRecord(record.error)?.message) ??
        "";
    }
  } catch {
    // Plain command output is already the diagnostic.
  }
  // Normalize before redaction, retaining line boundaries for multiline credentials.
  const normalized = stripAnsi(text)
    .split(/\r\n?|\n/u)
    .map(sanitizeTerminalText)
    .join("\n");
  const safe = redactToolPayloadText(normalized);
  const firstLine = safe.split(/\r\n?|\n/u).find((line) => line.trim());
  return firstLine ? truncateUtf16Safe(firstLine.trim(), 180) : undefined;
}

/** Keep the first failed operation visible even when later calls recover. */
export function renderToolFailures(cards: readonly ToolCard[], includePurpose = true) {
  const failures = cards.filter(isToolCardError);
  const first = failures[0];
  if (!first) {
    return nothing;
  }
  const display = resolveToolDisplay({ name: first.name, args: first.args, detailMode: "explain" });
  const purpose = includePurpose
    ? redactToolPayloadText(display.detail ?? display.label)
    : undefined;
  const reason = failureExcerpt(first.outputText);
  const outcome =
    first.exitCode === undefined
      ? t("chat.toolCards.failed")
      : t("chat.toolCards.exitCode", { code: String(first.exitCode) });
  return html`<div class="chat-tool-failure">
    <span class="chat-tool-failure__status"
      >${
        includePurpose
          ? t("chat.toolCards.failureCount", { count: String(failures.length) })
          : outcome
      }</span
    >
    <span>${[purpose, reason].filter(Boolean).join(" — ")}</span>
  </div>`;
}
