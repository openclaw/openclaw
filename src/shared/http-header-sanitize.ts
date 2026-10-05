// Node encodes response header values as Latin-1 and rejects any value that is
// not encodable to that charset with ERR_INVALID_CHAR when the header is
// written (empirically: characters above U+00FF, CR, LF, NUL, DEL, and control
// characters). Forwarded upstream headers - most commonly a Content-Disposition
// filename - can carry such characters and would otherwise crash the process at
// the response-writing boundary. These helpers make forwarded header values
// writable while preserving filenames via RFC 5987.
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

// Anything outside the Latin-1 printable set, DEL, and control characters is
// rejected by Node's header encoding. A negated class avoids control-character
// escapes and matches astral characters too; scrubbing the rare tab is a
// harmless conservative choice over Node's exact accepted set.
const INVALID_HEADER_CHARACTER = /[^\x20-\x7E\x80-\xFF]/u;

export function isHeaderValueLatin1Safe(value: string): boolean {
  return !INVALID_HEADER_CHARACTER.test(value);
}

/** Replaces characters Node's Latin-1 header encoding rejects, keeping the rest verbatim. */
export function sanitizeLatin1HeaderValue(value: string): string {
  return value.split(INVALID_HEADER_CHARACTER).join("_");
}

/**
 * Makes an existing Content-Disposition value writable. Values that are already
 * Latin-1 safe are returned unchanged. Otherwise the filename is preserved with
 * an ASCII fallback plus RFC 5987 `filename*=UTF-8''…` and any remaining
 * unencodable parameter text is scrubbed, matching the encoding used by the
 * Gateway's own media responses.
 */
export function sanitizeContentDispositionHeader(value: string): string {
  if (isHeaderValueLatin1Safe(value)) {
    return value;
  }
  const parts = splitHeaderList(value);
  const type = parts.shift()?.trim() || "attachment";
  const params: string[] = [];
  let filename: string | undefined;
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      params.push(trimmed);
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (name.toLowerCase() === "filename" && !isHeaderValueLatin1Safe(raw)) {
      filename = parseQuotedHeaderValue(raw);
      continue;
    }
    params.push(isHeaderValueLatin1Safe(trimmed) ? trimmed : sanitizeLatin1HeaderValue(trimmed));
  }
  if (filename !== undefined) {
    const safe = toWellFormedFilename(filename.replace(/[\r\n]/g, "_"));
    const fallback = safe.replace(/[^\x20-\x7e]|[%"\\]/g, "_").trim() || "download";
    const extended = encodeURIComponent(safe).replace(/[\x27()*]/g, (char) => {
      return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
    });
    params.push(`filename="${fallback}"`, `filename*=UTF-8''${extended}`);
  }
  return [type, ...params].join("; ");
}

/**
 * Makes every value in a forwarded response header set writable for Node's
 * Latin-1 encoding. Content-Disposition filenames are re-encoded with an ASCII
 * fallback plus RFC 5987; other values have only the unencodable characters
 * replaced. Array values (for example `set-cookie`) stay arrays.
 */
export function sanitizeForwardedResponseHeaders(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const sanitized: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      sanitized[name] = value.map((entry) => sanitizeForwardedHeaderValue(name, entry));
    } else {
      sanitized[name] = sanitizeForwardedHeaderValue(name, value);
    }
  }
  return sanitized;
}

function sanitizeForwardedHeaderValue(name: string, value: string): string {
  if (isHeaderValueLatin1Safe(value)) {
    return value;
  }
  if (name.toLowerCase() === "content-disposition") {
    return sanitizeContentDispositionHeader(value);
  }
  return sanitizeLatin1HeaderValue(value);
}

function splitHeaderList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quoted) {
      current += char;
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === ";") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function parseQuotedHeaderValue(raw: string): string {
  if (!raw.startsWith('"')) {
    return raw;
  }
  const end = raw.endsWith('"') ? raw.length - 1 : raw.length;
  let result = "";
  let escaped = false;
  for (let index = 1; index < end; index += 1) {
    const char = raw[index];
    if (escaped) {
      result += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else {
      result += char;
    }
  }
  return result;
}

function toWellFormedFilename(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    result += char.length === 1 && code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : char;
  }
  return result;
}
