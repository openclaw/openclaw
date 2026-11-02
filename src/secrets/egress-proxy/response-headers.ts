import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const ASCII_HEADER_VALUE = /^[\t\x20-\x7e]*$/;
const DISPOSITION_PARAM = /;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Makes upstream response headers safe to hand to `ServerResponse.writeHead`.
 *
 * Node exposes received header bytes as latin1 strings and forwards them as-is,
 * except Content-Disposition: once Content-Length is stored, Node revalidates it
 * as UTF-8 and throws ERR_INVALID_CHAR for non-ASCII filename bytes. Only that
 * header is rewritten; RFC 6266 `filename*` keeps the exact name.
 */
export function toForwardableResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const disposition = headers["content-disposition"];
  if (disposition === undefined || ASCII_HEADER_VALUE.test(disposition)) {
    return headers;
  }
  return { ...headers, "content-disposition": toAsciiContentDisposition(disposition) };
}

function toAsciiContentDisposition(value: string): string {
  const text = decodeReceivedHeaderValue(value);
  const type = text.split(";", 1)[0]?.trim() ?? "";
  if (!ASCII_HEADER_VALUE.test(type) || !type) {
    return toAsciiFallback(text);
  }
  const params: string[] = [];
  let filename: string | undefined;
  let extendedFilename: string | undefined;
  for (const [, rawName = "", rawValue = ""] of text.matchAll(DISPOSITION_PARAM)) {
    const name = rawName.toLowerCase();
    const paramValue = rawValue.trim();
    if (name === "filename") {
      filename = unquote(paramValue);
    } else if (name === "filename*" && ASCII_HEADER_VALUE.test(paramValue)) {
      // An upstream RFC 8187 value is authoritative; keep it verbatim.
      extendedFilename = paramValue;
    } else if (ASCII_HEADER_VALUE.test(paramValue)) {
      params.push(`${rawName}=${paramValue}`);
    }
  }
  if (filename !== undefined) {
    params.push(`filename="${toAsciiFallback(filename).replace(/[%"\\]/g, "_")}"`);
    extendedFilename ??= ASCII_HEADER_VALUE.test(filename)
      ? undefined
      : `UTF-8''${encodeRfc8187(filename)}`;
  }
  if (extendedFilename !== undefined) {
    params.push(`filename*=${extendedFilename}`);
  }
  return [type, ...params].join("; ");
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

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;
}

function encodeRfc8187(value: string): string {
  // encodeURIComponent throws on lone surrogates.
  return encodeURIComponent(value.replace(/\p{Surrogate}/gu, "\uFFFD")).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function toAsciiFallback(value: string): string {
  return Array.from(value, (char) => (ASCII_HEADER_VALUE.test(char) ? char : "_")).join("");
}
