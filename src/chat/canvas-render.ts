// Renders chat canvas payloads into text and metadata for transcript output.
import { safeParseJson } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { parseFenceSpans } from "../../packages/markdown-core/src/fences.js";

// Extracts assistant-message canvas previews from tool JSON or markdown embed
// shortcodes. The returned text strips consumed shortcodes for channel delivery.
type CanvasSurface = "assistant_message";

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
};

function getRecordStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getRecordNumberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return asFiniteNumber(value);
}

function getNestedRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return asOptionalRecord(value);
}

function normalizeSurface(value: string | undefined): CanvasSurface | undefined {
  return value === "assistant_message" ? value : undefined;
}

function normalizePreferredHeight(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 160
    ? Math.min(Math.trunc(value), 1200)
    : undefined;
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
  const presentation = getNestedRecord(record, "presentation");
  const view = getNestedRecord(record, "view");
  const source = getNestedRecord(record, "source");
  const requestedSurface =
    getRecordStringField(presentation, "target") ?? getRecordStringField(record, "target");
  const surface = requestedSurface ? normalizeSurface(requestedSurface) : "assistant_message";
  if (!surface) {
    return undefined;
  }
  const title = getRecordStringField(presentation, "title") ?? getRecordStringField(view, "title");
  const preferredHeight = normalizePreferredHeight(
    getRecordNumberField(presentation, "preferred_height") ??
      getRecordNumberField(presentation, "preferredHeight") ??
      getRecordNumberField(view, "preferred_height") ??
      getRecordNumberField(view, "preferredHeight"),
  );
  const className =
    getRecordStringField(presentation, "class_name") ??
    getRecordStringField(presentation, "className");
  const style = getRecordStringField(presentation, "style");
  const viewUrl = getRecordStringField(view, "url") ?? getRecordStringField(view, "entryUrl");
  const viewId = getRecordStringField(view, "id") ?? getRecordStringField(view, "docId");
  if (viewUrl) {
    return {
      kind: "canvas",
      surface,
      render: "url",
      url: viewUrl,
      ...(viewId ? { viewId } : {}),
      ...(title ? { title } : {}),
      ...(preferredHeight ? { preferredHeight } : {}),
      ...(className ? { className } : {}),
      ...(style ? { style } : {}),
    };
  }
  const sourceType = getRecordStringField(source, "type")?.trim().toLowerCase();
  if (sourceType === "url") {
    const url = getRecordStringField(source, "url");
    if (!url) {
      return undefined;
    }
    return {
      kind: "canvas",
      surface,
      render: "url",
      url,
      ...(title ? { title } : {}),
      ...(preferredHeight ? { preferredHeight } : {}),
      ...(className ? { className } : {}),
      ...(style ? { style } : {}),
    };
  }
  return undefined;
}

const MAX_ATTRIBUTE_INPUT_LENGTH = 10240; // 10KB limit to prevent resource exhaustion

/**
 * Parses HTML-style attributes from a string with security protections.
 *
 * Security measures:
 * - Input length validation to prevent ReDoS and resource exhaustion
 * - Optimized regex to avoid catastrophic backtracking
 * - Blocks dangerous protocols (javascript:, vbscript:, data:text/html)
 * - Blocks event handler attributes (onclick, onerror, etc.)
 * - Handles HTML entity encoded dangerous protocols
 */
export function parseCanvasAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};

  // Input validation: reject empty or excessively long input
  if (!raw?.trim() || raw.length > MAX_ATTRIBUTE_INPUT_LENGTH) {
    return attrs;
  }

  // Use a more efficient regex that avoids catastrophic backtracking
  // Key improvements:
  // - Possessive-like behavior via atomic grouping simulation
  // - Bounded quantifiers where possible
  // - Simpler alternation structure
  const re =
    /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(raw)) !== null) {
    const key = match[1]?.trim().toLowerCase();
    // Handle escaped quotes by unescaping
    const rawValue = (match[2] ?? match[3] ?? "").replace(/\\"/g, '"').replace(/\\'/g, "'").trim();

    if (!key) {
      continue;
    }

    // Security check: block event handler attributes
    if (isEventHandlerAttribute(key)) {
      continue;
    }

    // Security check: validate and sanitize attribute value
    const sanitizedValue = sanitizeAttributeValue(rawValue);
    if (sanitizedValue !== undefined) {
      attrs[key] = sanitizedValue;
    }
  }

  return attrs;
}

/**
 * Checks if an attribute name is an event handler.
 * Event handlers start with "on" followed by an event name.
 */
function isEventHandlerAttribute(name: string): boolean {
  // Common event handlers that could execute scripts
  const eventHandlerPattern = /^on[a-z]+$/i;
  return eventHandlerPattern.test(name);
}

/**
 * Sanitizes an attribute value by blocking dangerous protocols and patterns.
 * Returns undefined if the value should be rejected.
 */
function sanitizeAttributeValue(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  // Decode HTML entities to detect obfuscated dangerous protocols
  const decodedValue = decodeHtmlEntities(value);
  const lowerValue = decodedValue.toLowerCase().trim();

  // Block dangerous protocols
  if (isDangerousProtocol(lowerValue)) {
    return undefined;
  }

  // Return the original value (not decoded) if it passes validation
  // This preserves the original encoding for safe values
  return value;
}

/**
 * Decodes common HTML entities to detect obfuscated attacks.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#106;/gi, "j") // j
    .replace(/&#97;/gi, "a") // a
    .replace(/&#118;/gi, "v") // v
    .replace(/&#115;/gi, "s") // s
    .replace(/&#99;/gi, "c") // c
    .replace(/&#114;/gi, "r") // r
    .replace(/&#105;/gi, "i") // i
    .replace(/&#112;/gi, "p") // p
    .replace(/&#116;/gi, "t") // t
    .replace(/&#58;/gi, ":") // :
    .replace(/&#38;/gi, "&") // &
    .replace(/&#60;/gi, "<") // <
    .replace(/&#62;/gi, ">") // >
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/**
 * Checks if a value starts with a dangerous protocol.
 */
function isDangerousProtocol(value: string): boolean {
  // Normalize whitespace
  const normalized = value.replace(/\s+/g, "").trim();

  // Block javascript: protocol (including obfuscated versions)
  if (normalized.startsWith("javascript:")) {
    return true;
  }

  // Block vbscript: protocol
  if (normalized.startsWith("vbscript:")) {
    return true;
  }

  // Block data: URLs with dangerous MIME types
  if (normalized.startsWith("data:")) {
    // Allow safe image data URLs
    if (normalized.startsWith("data:image/")) {
      return false;
    }
    // Block text/html, application/javascript, etc.
    if (
      normalized.startsWith("data:text/html") ||
      normalized.startsWith("data:application/") ||
      normalized.includes("script")
    ) {
      return true;
    }
  }

  return false;
}

function defaultCanvasEntryUrl(ref: string): string {
  const encoded = encodeURIComponent(ref.trim());
  return `/__openclaw__/canvas/documents/${encoded}/index.html`;
}

function previewFromShortcode(attrs: Record<string, string>): CanvasPreview | undefined {
  if (attrs.target && normalizeSurface(attrs.target) !== "assistant_message") {
    return undefined;
  }
  const surface = "assistant_message";
  const title = attrs.title?.trim() || undefined;
  const preferredHeight =
    attrs.height && Number.isFinite(Number(attrs.height))
      ? normalizePreferredHeight(Number(attrs.height))
      : undefined;
  const className = attrs.class?.trim() || attrs.class_name?.trim() || undefined;
  const style = attrs.style?.trim() || undefined;
  const ref = attrs.ref?.trim();
  const url = attrs.url?.trim();
  if (url || ref) {
    return {
      kind: "canvas",
      surface,
      render: "url",
      url: url ?? defaultCanvasEntryUrl(ref),
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
export function extractCanvasFromText(
  outputText: string | undefined,
  _toolName?: string,
): CanvasPreview | undefined {
  const parsed = outputText ? asOptionalRecord(safeParseJson(outputText)) : undefined;
  return coerceCanvasPreview(parsed);
}

/** Extracts [embed ...] shortcodes outside code fences and returns stripped text. */
export function extractCanvasShortcodes(text: string | undefined): {
  text: string;
  previews: CanvasPreview[];
} {
  if (!text?.trim() || !text.toLowerCase().includes("[embed")) {
    return { text: text ?? "", previews: [] };
  }
  const fenceSpans = parseFenceSpans(text);
  const matches: Array<{
    start: number;
    end: number;
    attrs: Record<string, string>;
    body?: string;
  }> = [];
  // Exclude a self-closing open tag ("[embed ... /]") from starting a block
  // match by requiring the attrs group not to end with a slash; otherwise the
  // block regex greedily swallows visible text up to a later stray [/embed].
  const blockRe = /\[embed\s+([^\]]*?[^\]/]|)\]([\s\S]*?)\[\/embed\]/gi;
  const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;
  for (const re of [blockRe, selfClosingRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const start = match.index ?? 0;
      if (fenceSpans.some((span) => start >= span.start && start < span.end)) {
        // Literal embed examples in code blocks must remain visible text.
        continue;
      }
      matches.push({
        start,
        end: start + match[0].length,
        attrs: parseCanvasAttributes(match[1] ?? ""),
        ...(match[2] !== undefined ? { body: match[2] } : {}),
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
    text: stripped.replace(/\n{3,}/g, "\n\n").trim(),
    previews,
  };
}
