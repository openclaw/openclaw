import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { unwrapToolCallForDisplay } from "../agents/tool-display-call.js";
import { parseCanvasDocumentHttpPath } from "../canvas/documents.js";
import { extractCanvasFromRecord, extractCanvasShortcodes } from "../chat/canvas-render.js";
import { isToolCallContentType, resolveToolBlockArgs } from "../chat/tool-content.js";
import { collectPublicSessionAttachments } from "./control-ui-public-session-attachments.js";
import {
  publicSessionMessageEntry,
  publicSessionMessageText,
  readPublicWidgetReceipt,
} from "./control-ui-public-session-message.js";

type PublicSessionWidget = { kind: "widget"; docId: string; title?: string; height?: number };
type PublicSessionEmbed = PublicSessionWidget | { kind: "link"; href: string; title?: string };

export type PublicSessionItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
      message: unknown;
      sourceIndex: number;
      /** Shortcode order, then the turn's tool-receipt widget. */
      embeds: PublicSessionEmbed[];
    }
  | { kind: "tools"; calls: { name: string; summary: string }[]; sourceIndex: number };

function toolSummary(args: unknown): string {
  const record = asOptionalRecord(args);
  // Publish a useful argument only, never the entire tool payload or result body.
  const selected = record
    ? ["command", "cmd", "path", "file_path", "query", "q", "url"]
        .map((key) => record[key])
        .find((value) => typeof value === "string")
    : typeof args === "string"
      ? args
      : undefined;
  return typeof selected === "string"
    ? truncateUtf16Safe(selected.replace(/\s+/gu, " ").trim(), 160)
    : "";
}

/** Public links leave the reader only on a click: absolute http(s), never embedded credentials. */
export function publicSessionLinkHref(value: string | undefined): string | undefined {
  const url = value ? URL.parse(value) : null;
  return url &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password
    ? url.href
    : undefined;
}

function hostedWidget(
  preview: ReturnType<typeof extractCanvasFromRecord>,
): PublicSessionWidget | undefined {
  if (!preview?.url) {
    return undefined;
  }
  const path = parseCanvasDocumentHttpPath(preview.url);
  if (!path || preview.mcpApp || (preview.viewId && preview.viewId !== path.documentId)) {
    return undefined;
  }
  return {
    kind: "widget",
    docId: path.documentId,
    title: preview.title,
    height: preview.preferredHeight,
  };
}

/** Same visible-content boundary as chat: narration separates adjacent tool activity. */
export function projectPublicSessionItems(messages: unknown[]): PublicSessionItem[] {
  const items: PublicSessionItem[] = [];
  const receiptTitles = new Map<string, string>();
  const prepared = messages.map((message) => {
    const entry = publicSessionMessageEntry(message);
    const receipt = hostedWidget(extractCanvasFromRecord(readPublicWidgetReceipt(message)));
    if (receipt?.title) {
      receiptTitles.set(receipt.docId, receipt.title);
    }
    const text = entry ? publicSessionMessageText(entry) : "";
    const shortcodes = extractCanvasShortcodes(entry?.role === "assistant" ? text : undefined);
    // The reader never frames third-party pages; private Gateway pages are omitted.
    const shortcodeEmbeds = shortcodes.previews.flatMap((preview): PublicSessionEmbed[] => {
      const widget = hostedWidget(preview);
      const href = widget ? undefined : publicSessionLinkHref(preview.url);
      return widget ? [widget] : href ? [{ kind: "link", href, title: preview.title }] : [];
    });
    return {
      message,
      entry,
      receipt,
      text: entry?.role === "assistant" ? shortcodes.text : text,
      shortcodeEmbeds,
      deferReceipt: false,
    };
  });
  // A shortcode owns its turn's preview, even when the tool receipt came first.
  const laterWidgets = new Set<string>();
  for (const row of prepared.toReversed()) {
    if (row.entry?.role === "user") {
      laterWidgets.clear();
    }
    row.deferReceipt = Boolean(row.receipt && laterWidgets.has(row.receipt.docId));
    for (const embed of row.shortcodeEmbeds) {
      if (embed.kind === "widget") {
        laterWidgets.add(embed.docId);
      }
    }
  }
  const rendered = new Set<string>();
  for (const [
    sourceIndex,
    { message, entry, receipt, text, shortcodeEmbeds, deferReceipt },
  ] of prepared.entries()) {
    const embeds: PublicSessionEmbed[] = [];
    for (const embed of [...shortcodeEmbeds, ...(receipt && !deferReceipt ? [receipt] : [])]) {
      if (embed.kind === "link") {
        embeds.push(embed);
      } else if (!rendered.has(embed.docId)) {
        rendered.add(embed.docId);
        embeds.push({ ...embed, title: embed.title ?? receiptTitles.get(embed.docId) });
      }
    }
    const attachments = entry ? collectPublicSessionAttachments(entry) : [];
    if (text || attachments.length > 0 || embeds.length > 0) {
      items.push({
        kind: "message",
        role: entry?.role === "user" ? "user" : "assistant",
        text,
        message,
        sourceIndex,
        embeds,
      });
    }
    if (entry?.role !== "assistant" || !Array.isArray(entry.content)) {
      continue;
    }
    for (const value of entry.content) {
      const block = asOptionalRecord(value);
      if (!block || !isToolCallContentType(block.type)) {
        continue;
      }
      const call = unwrapToolCallForDisplay({
        name: typeof block.name === "string" ? block.name : "tool",
        args: resolveToolBlockArgs(block),
      });
      const name = truncateUtf16Safe(call.name, 80);
      const summary = toolSummary(call.args);
      const previous = items.at(-1);
      if (previous?.kind === "tools") {
        previous.calls.push({ name, summary });
      } else {
        items.push({ kind: "tools", calls: [{ name, summary }], sourceIndex });
      }
    }
  }
  return items;
}
