import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

// Transient input snapshots have a separate budget from published Canvas documents.
export const WIDGET_INPUT_PREVIEW_MAX_CHARS = 128 * 1024;

export type WidgetInputPreview = { title: string; html: string };

export type WidgetInputPreviewEvent = {
  phase: "widget_preview";
  name: "show_widget";
  toolCallId: string;
  preview: WidgetInputPreview | null;
};

/** Decode the small live-only payload at the Gateway client boundary. */
export function readWidgetInputPreview(value: unknown): WidgetInputPreview | undefined {
  const record = asOptionalRecord(value);
  return typeof record?.title === "string" &&
    record.title.length <= 256 &&
    typeof record.html === "string" &&
    record.html.length > 0 &&
    record.html.length <= WIDGET_INPUT_PREVIEW_MAX_CHARS
    ? { title: record.title, html: record.html }
    : undefined;
}
