import type { CanvasToolPreview } from "../../../lib/chat/tool-cards.ts";
import type { ChatWidgetLayout } from "../session-message-cache.ts";

export function isManagedCanvasDocumentPreview(preview: CanvasToolPreview): boolean {
  const viewId = preview.viewId?.trim();
  const entryUrl = preview.url?.trim();
  if (!viewId || !entryUrl) {
    return false;
  }
  try {
    const entry = new URL(entryUrl, "http://localhost");
    const prefix = "/__openclaw__/canvas/documents/";
    if (entry.origin !== "http://localhost" || !entry.pathname.startsWith(prefix)) {
      return false;
    }
    const [encodedDocumentId, entrypoint] = entry.pathname.slice(prefix.length).split("/", 2);
    if (!encodedDocumentId || !entrypoint) {
      return false;
    }
    const documentId = decodeURIComponent(encodedDocumentId);
    return /^[A-Za-z0-9._-]+$/u.test(documentId) && documentId === viewId;
  } catch {
    return false;
  }
}

export function widgetPreviewLayoutKey(preview: CanvasToolPreview): string {
  return preview.mcpApp
    ? `mcp:${preview.mcpApp.viewId}`
    : preview.sandbox !== "strict" && isManagedCanvasDocumentPreview(preview)
      ? `canvas:${preview.viewId!.trim()}`
      : `frame:${preview.url?.trim() || preview.viewId?.trim()}`;
}

/** The lazy placeholder and admitted widget must reserve the same saved geometry. */
export function widgetPreviewHeight(preview: CanvasToolPreview, layout?: ChatWidgetLayout): number {
  return (
    layout?.read(widgetPreviewLayoutKey(preview)) ??
    preview.preferredHeight ??
    (preview.mcpApp ? 600 : 420)
  );
}
