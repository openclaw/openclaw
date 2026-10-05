import { expectDefined, safeParseJsonRecord } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";

type CanvasSurface = "assistant_message" | "node_panel";
type CanvasSandbox = "strict" | "scripts";

type McpAppPreviewDescriptor = {
  viewId: string;
  serverName?: string;
  toolName?: string;
  uiResourceUri?: string;
  toolCallId?: string;
  originSessionKey?: string;
  resultMetaState?: "unavailable";
};

type CanvasPreview = {
  kind: "canvas";
  surface: CanvasSurface;
  render: "url";
  title?: string;
  preferredHeight?: number;
  url?: string;
  viewId?: string;
  className?: string;
  style?: string;
  sandbox?: CanvasSandbox;
  boardWidgetName?: string;
  mcpApp?: McpAppPreviewDescriptor;
};

function getRecordStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function coerceMcpAppDescriptor(
  record: Record<string, unknown> | undefined,
): McpAppPreviewDescriptor | undefined {
  const viewId = getRecordStringField(record, "viewId");
  if (!viewId || viewId.length > 128) {
    return undefined;
  }
  const serverName = getRecordStringField(record, "serverName");
  const toolName = getRecordStringField(record, "toolName");
  const uiResourceUri = getRecordStringField(record, "uiResourceUri");
  const toolCallId = getRecordStringField(record, "toolCallId");
  const originSessionKey = getRecordStringField(record, "originSessionKey");
  const resultMetaState = record?.resultMetaState === "unavailable" ? "unavailable" : undefined;
  const hasCompleteDescriptor = Boolean(
    serverName &&
    serverName.length <= 256 &&
    toolName &&
    toolName.length <= 256 &&
    uiResourceUri?.startsWith("ui://") &&
    uiResourceUri.length <= 2048 &&
    toolCallId &&
    toolCallId.length <= 512,
  );
  return hasCompleteDescriptor
    ? {
        viewId,
        serverName,
        toolName,
        uiResourceUri,
        toolCallId,
        ...(originSessionKey && originSessionKey.length <= 512 ? { originSessionKey } : {}),
        ...(resultMetaState ? { resultMetaState } : {}),
      }
    : { viewId };
}

function normalizePreferredHeight(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 160
    ? Math.min(Math.trunc(value), 1200)
    : undefined;
}

export function isCanvasBoardWidgetName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value);
}

function coerceCanvasPreview(
  record: Record<string, unknown> | undefined,
): CanvasPreview | undefined {
  if (!record) {
    return undefined;
  }
  const kind = getRecordStringField(record, "kind")?.trim().toLowerCase();
  if (kind !== "canvas") {
    return undefined;
  }
  const presentation = asOptionalRecord(record.presentation);
  const view = asOptionalRecord(record.view);
  const source = asOptionalRecord(record.source);
  const mcpApp = coerceMcpAppDescriptor(asOptionalRecord(record.mcpApp));
  const mcpAppViewId = mcpApp?.viewId;
  const requestedSurface =
    getRecordStringField(presentation, "target") ?? getRecordStringField(record, "target");
  const surface = requestedSurface ?? "assistant_message";
  if (surface !== "assistant_message" && surface !== "node_panel") {
    return undefined;
  }
  const title = getRecordStringField(presentation, "title") ?? getRecordStringField(view, "title");
  const preferredHeight = normalizePreferredHeight(
    asFiniteNumber(presentation?.preferred_height) ??
      asFiniteNumber(presentation?.preferredHeight) ??
      asFiniteNumber(view?.preferred_height) ??
      asFiniteNumber(view?.preferredHeight),
  );
  const className =
    getRecordStringField(presentation, "class_name") ??
    getRecordStringField(presentation, "className");
  const style = getRecordStringField(presentation, "style");
  const sandbox = getRecordStringField(presentation, "sandbox");
  const viewUrl = getRecordStringField(view, "url") ?? getRecordStringField(view, "entryUrl");
  const viewId = getRecordStringField(view, "id") ?? getRecordStringField(view, "docId");
  const requestedBoardWidgetName = getRecordStringField(view, "boardWidgetName");
  const boardWidgetName = isCanvasBoardWidgetName(requestedBoardWidgetName)
    ? requestedBoardWidgetName
    : undefined;
  const preview: CanvasPreview = {
    kind: "canvas",
    surface,
    render: "url",
    ...(title ? { title } : {}),
    ...(preferredHeight ? { preferredHeight } : {}),
    ...(sandbox === "strict" || sandbox === "scripts" ? { sandbox } : {}),
    ...(mcpApp ? { mcpApp } : {}),
  };
  if (mcpAppViewId && viewId === mcpAppViewId) {
    return { ...preview, viewId };
  }
  const url =
    viewUrl ??
    (getRecordStringField(source, "type")?.trim().toLowerCase() === "url"
      ? getRecordStringField(source, "url")
      : undefined);
  if (!url) {
    return undefined;
  }
  return {
    ...preview,
    url,
    ...(viewUrl && viewId ? { viewId } : {}),
    ...(className ? { className } : {}),
    ...(style ? { style } : {}),
    ...(viewUrl && boardWidgetName ? { boardWidgetName } : {}),
  };
}

/** Extracts an MCP App Canvas preview from sanitized tool-result details. */
export function extractCanvasFromDetails(value: unknown): CanvasPreview | undefined {
  const details = asOptionalRecord(value);
  return coerceCanvasPreview(asOptionalRecord(details?.mcpAppPreview));
}

function parseCanvasAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const key = match[1]?.trim().toLowerCase();
    const value = (match[2] ?? match[3] ?? "").trim();
    if (key && value) {
      attrs[key] = value;
    }
  }
  return attrs;
}

function previewFromShortcode(attrs: Record<string, string>): CanvasPreview | undefined {
  if (attrs.target && attrs.target !== "assistant_message") {
    return undefined;
  }
  const { title, style, ref, url } = attrs;
  const preferredHeight = normalizePreferredHeight(Number(attrs.height));
  const className = attrs.class ?? attrs.class_name;
  if (url || ref) {
    return {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      url:
        url ??
        `/__openclaw__/canvas/documents/${encodeURIComponent(expectDefined(ref, "canvas reference"))}/index.html`,
      ...(ref ? { viewId: ref } : {}),
      ...(title ? { title } : {}),
      ...(preferredHeight ? { preferredHeight } : {}),
      ...(className ? { className } : {}),
      ...(style ? { style } : {}),
    };
  }
  return undefined;
}

/** Extracts a canvas preview from a JSON-shaped tool or assistant payload. */
export function extractCanvasFromText(outputText: string | undefined): CanvasPreview | undefined {
  const parsed = outputText ? safeParseJsonRecord(outputText) : undefined;
  return coerceCanvasPreview(parsed);
}

/** Extracts [embed ...] shortcodes outside Markdown code and returns stripped text. */
export function extractCanvasShortcodes(text: string | undefined): {
  text: string;
  previews: CanvasPreview[];
} {
  if (!text?.trim() || !text.toLowerCase().includes("[embed")) {
    return { text: text ?? "", previews: [] };
  }
  const codeRegions = findCodeRegions(text);
  const matches: Array<{
    start: number;
    end: number;
    attrs: Record<string, string>;
  }> = [];
  // Exclude a self-closing open tag ("[embed ... /]") from starting a block
  // match by requiring the attrs group not to end with a slash; otherwise the
  // block regex greedily swallows visible text up to a later stray [/embed].
  const blockRe = /\[embed\s+([^\]]*?[^\]/]|)\]([\s\S]*?)\[\/embed\]/gi;
  const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;
  for (const re of [blockRe, selfClosingRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const start = match.index;
      if (isInsideCode(start, codeRegions)) {
        // Literal embed examples in code must remain visible text.
        continue;
      }
      matches.push({
        start,
        end: start + match[0].length,
        attrs: parseCanvasAttributes(match[1] ?? ""),
      });
    }
  }
  if (matches.length === 0) {
    return { text, previews: [] };
  }
  matches.sort((a, b) => a.start - b.start);
  const previews: CanvasPreview[] = [];
  let cursor = 0;
  let stripped = "";
  for (const match of matches) {
    if (match.start < cursor) {
      // Prefer the first non-overlapping shortcode so nested/overlapping input
      // cannot strip arbitrary text outside the matched span.
      continue;
    }
    stripped += text.slice(cursor, match.start);
    const preview = previewFromShortcode(match.attrs);
    if (!preview) {
      stripped += text.slice(match.start, match.end);
    } else {
      previews.push(preview);
    }
    cursor = match.end;
  }
  stripped += text.slice(cursor);
  return {
    text: stripped,
    previews,
  };
}
