import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { unwrapToolCallForDisplay } from "../agents/tool-display-call.js";
import { parseCanvasDocumentHttpPath } from "../canvas/documents.js";
import { extractCanvasFromRecord, extractCanvasShortcodes } from "../chat/canvas-render.js";
import { isToolCallContentType, resolveToolBlockArgs } from "../chat/tool-content.js";
import { readInlineWidgetReceipt } from "../sessions/transcript-visible-record.js";
import { collectPublicSessionAttachments } from "./control-ui-public-session-attachments.js";
import {
  publicSessionMessageEntry,
  publicSessionMessageText,
} from "./control-ui-public-session-message.js";

type PublicSessionWidget = { docId: string; title?: string; height?: number };

export type PublicSessionItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
      message: unknown;
      sourceIndex: number;
      widgets: PublicSessionWidget[];
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
  return { docId: path.documentId, title: preview.title, height: preview.preferredHeight };
}

/** Same visible-content boundary as chat: narration separates adjacent tool activity. */
export function projectPublicSessionItems(messages: unknown[]): PublicSessionItem[] {
  const items: PublicSessionItem[] = [];
  const receiptTitles = new Map<string, string>();
  const prepared = messages.map((message) => {
    const entry = publicSessionMessageEntry(message);
    const receipt =
      entry || asOptionalRecord(message)?.role === "custom"
        ? hostedWidget(extractCanvasFromRecord(readInlineWidgetReceipt(message)))
        : undefined;
    if (receipt?.title) {
      receiptTitles.set(receipt.docId, receipt.title);
    }
    const text = entry ? publicSessionMessageText(entry) : "";
    const shortcodes = extractCanvasShortcodes(
      entry?.role === "assistant" ? text : undefined,
      (preview) => Boolean(hostedWidget(preview)),
    );
    return {
      message,
      entry,
      receipt,
      text: entry?.role === "assistant" ? shortcodes.text : text,
      widgets: shortcodes.previews.map((preview) => hostedWidget(preview)!),
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
    for (const widget of row.widgets) {
      laterWidgets.add(widget.docId);
    }
  }
  const rendered = new Set<string>();
  for (const [
    sourceIndex,
    { message, entry, receipt, text, widgets: shortcodes, deferReceipt },
  ] of prepared.entries()) {
    const widgets: PublicSessionWidget[] = [];
    for (const widget of [...shortcodes, ...(receipt && !deferReceipt ? [receipt] : [])]) {
      if (!rendered.has(widget.docId)) {
        rendered.add(widget.docId);
        widgets.push({ ...widget, title: widget.title ?? receiptTitles.get(widget.docId) });
      }
    }
    const attachments = entry ? collectPublicSessionAttachments(entry) : [];
    if (text || attachments.length > 0 || widgets.length > 0) {
      items.push({
        kind: "message",
        role: entry?.role === "user" ? "user" : "assistant",
        text,
        message,
        sourceIndex,
        widgets,
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
