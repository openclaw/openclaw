import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const FORWARDABLE_HEADER_VALUE = /^[\t\x20-\x7e]*$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Makes upstream response headers safe to hand to `ServerResponse.writeHead`.
 *
 * Node exposes received header bytes as latin1 strings. Writing non-ASCII values
 * back is order-dependent: once Content-Length is stored, Node revalidates a later
 * value as UTF-8 and throws ERR_INVALID_CHAR. Forward ASCII only; filenames keep
 * their exact name through RFC 6266 `filename*`.
 */
export function toForwardableResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const forwardable: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    forwardable[name] = Array.isArray(value)
      ? value.map((entry) => toForwardableHeaderValue(name, entry))
      : toForwardableHeaderValue(name, value);
  }
  return forwardable;
}

function toForwardableHeaderValue(name: string, value: string): string {
  if (FORWARDABLE_HEADER_VALUE.test(value)) {
    return value;
  }
  const text = decodeReceivedHeaderValue(value);
  if (name === "content-disposition") {
    const disposition = encodeContentDisposition(text);
    if (disposition) {
      return disposition;
    }
  }
  return toAsciiFallback(text);
}

/** Recovers UTF-8 text from latin1-decoded wire bytes, keeping other values as received. */
function decodeReceivedHeaderValue(value: string): string {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0xff) {
      return value;
    }
  }
  try {
    return utf8Decoder.decode(Buffer.from(value, "latin1"));
  } catch {
    return value;
  }
}

function encodeContentDisposition(value: string): string | undefined {
  const type = value.split(";", 1)[0]?.trim();
  const match = /;\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(value);
  if (!type || !FORWARDABLE_HEADER_VALUE.test(type) || !match) {
    return undefined;
  }
  const filename = (match[1]?.replace(/\\(.)/g, "$1") ?? match[2] ?? "").trim();
  if (!filename) {
    return undefined;
  }
  const fallback = toAsciiFallback(filename).replace(/[%"\\]/g, "_");
  // encodeURIComponent throws on lone surrogates.
  const extended = encodeURIComponent(filename.replace(/\p{Surrogate}/gu, "�")).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

function toAsciiFallback(value: string): string {
  return Array.from(value, (char) => (FORWARDABLE_HEADER_VALUE.test(char) ? char : "_")).join("");
}
