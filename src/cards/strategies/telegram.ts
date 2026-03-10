/**
 * Telegram rendering strategy for Adaptive Cards.
 *
 * Converts AC elements to Telegram HTML text + inline keyboard buttons.
 */

import type { ParsedAdaptiveCard } from "../parse.js";
import type { CardRenderResult, CardRenderStrategy } from "../types.js";

type AcElement = Record<string, unknown>;

/** Safely coerce an unknown AC property to string. */
function str(val: unknown, fallback = ""): string {
  if (typeof val === "string") {
    return val;
  }
  if (val == null) {
    return fallback;
  }
  return JSON.stringify(val);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTextBlock(el: AcElement): string {
  const escaped = escapeHtml(str(el.text));
  const weight = el.weight as string | undefined;
  const isSubtle = el.isSubtle === true;

  let line = escaped;
  if (weight === "Bolder") {
    line = `<b>${line}</b>`;
  }
  if (isSubtle) {
    line = `<i>${line}</i>`;
  }
  return line;
}

function renderFactSet(el: AcElement): string {
  const facts = el.facts as Array<{ title?: string; value?: string }> | undefined;
  if (!facts?.length) {
    return "";
  }
  return facts
    .map((f) => `<b>${escapeHtml(f.title ?? "")}</b>: ${escapeHtml(f.value ?? "")}`)
    .join("\n");
}

function renderElement(el: AcElement): string {
  switch (el.type) {
    case "TextBlock":
      return renderTextBlock(el);
    case "FactSet":
      return renderFactSet(el);
    case "ColumnSet": {
      // Flatten columns into sequential elements
      const columns = el.columns as Array<{ items?: AcElement[] }> | undefined;
      if (!columns?.length) {
        return "";
      }
      return columns
        .flatMap((col) => (col.items ?? []).map(renderElement))
        .filter(Boolean)
        .join("\n");
    }
    case "Container": {
      const items = el.items as AcElement[] | undefined;
      return (items ?? []).map(renderElement).filter(Boolean).join("\n");
    }
    default:
      return "";
  }
}

type InlineButton = { text: string; url?: string; callback_data?: string };

function renderActions(actions: unknown[]): InlineButton[][] {
  const buttons: InlineButton[] = [];
  for (const raw of actions) {
    const action = raw as AcElement;
    const label = str(action.title);
    if (!label) {
      continue;
    }
    if (action.type === "Action.OpenUrl") {
      const url = str(action.url);
      if (!url) {
        continue; // skip: Telegram rejects inline buttons with an empty URL
      }
      buttons.push({ text: label, url });
    } else if (action.type === "Action.Submit") {
      // Encode action data as callback_data (Telegram limit: 64 bytes)
      const raw = action.data != null ? JSON.stringify(action.data) : label;
      // Truncate by UTF-8 byte length, not character count
      const encoder = new TextEncoder();
      let truncated = raw;
      while (encoder.encode(truncated).byteLength > 64) {
        truncated = truncated.slice(0, -1);
      }
      buttons.push({ text: label, callback_data: truncated });
    }
  }
  if (buttons.length === 0) {
    return [];
  }
  // One button per row
  return buttons.map((b) => [b]);
}

export const telegramStrategy: CardRenderStrategy = {
  name: "telegram",
  render(parsed: ParsedAdaptiveCard): CardRenderResult {
    const lines: string[] = [];
    for (const el of parsed.card.body) {
      const rendered = renderElement(el as AcElement);
      if (rendered) {
        lines.push(rendered);
      }
    }

    const text = lines.join("\n\n") || escapeHtml(parsed.fallbackText);

    const keyboard = parsed.card.actions?.length ? renderActions(parsed.card.actions) : [];

    if (keyboard.length === 0) {
      return { type: "telegram", text };
    }

    return {
      type: "telegram",
      text,
      replyMarkup: { inline_keyboard: keyboard },
    };
  },
};
