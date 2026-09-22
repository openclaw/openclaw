import type { IncomingHttpHeaders } from "node:http";

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DISPOSITION_TYPE = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)/;

// After content-length is stored, Node revalidates content-disposition as UTF-8
// and throws ERR_INVALID_CHAR for bytes that were legal latin1 on the wire.
export function sanitizeForwardedResponseHeaders(
  headers: IncomingHttpHeaders,
): IncomingHttpHeaders {
  const sanitized: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HTTP_TOKEN.test(name)) {
      continue;
    }
    const parts = headerFieldValues(value);
    if (!parts) {
      continue;
    }
    const next = parts.map((part) =>
      isContentDispositionField(name)
        ? sanitizeContentDisposition(part)
        : sanitizeGenericHeaderValue(part),
    );
    sanitized[name] = next.length === 1 ? next[0] : next;
  }
  return sanitized;
}

function isContentDispositionField(name: string): boolean {
  return name.length === 19 && name.toLowerCase() === "content-disposition";
}

function headerFieldValues(value: string | string[] | undefined): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.filter((entry): entry is string => typeof entry === "string");
  return parts.length > 0 ? parts : undefined;
}

function sanitizeContentDisposition(value: string): string {
  const decoded = decodeWireHeaderValue(value);
  if (isAsciiHeaderValue(decoded)) {
    return decoded;
  }
  const fileName = extractDispositionFileName(decoded);
  if (!fileName) {
    return forceAsciiHeaderValue(decoded);
  }
  const wellFormed = toWellFormedFilename(fileName.replace(/[\r\n]/g, "_"));
  const fallback = wellFormed.replace(/[^\x20-\x7e]|[%"\\]/g, "_").trim() || "download";
  const extended = encodeRfc5987Value(wellFormed.trim() ? wellFormed : fallback);
  return `${dispositionType(decoded)}; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

function sanitizeGenericHeaderValue(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0x09 || (code >= 0x20 && code <= 0xff && code !== 0x7f)) {
      result += char;
    } else if (code > 0xff) {
      result += "_";
    }
  }
  return result;
}

function forceAsciiHeaderValue(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0x09 || (code >= 0x20 && code <= 0x7e)) {
      result += char;
    } else if (code > 0x7e) {
      result += "_";
    }
  }
  return result;
}

function isAsciiHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
      return false;
    }
  }
  return true;
}

/** HTTP parsers expose header bytes as latin1. Recover UTF-8 when that is unambiguous. */
function decodeWireHeaderValue(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) {
      return value;
    }
  }
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  if (decoded !== value && !decoded.includes("\uFFFD")) {
    return decoded;
  }
  return value;
}

function dispositionType(value: string): string {
  return DISPOSITION_TYPE.exec(value.trimStart())?.[1]?.toLowerCase() ?? "attachment";
}

function extractDispositionFileName(value: string): string | undefined {
  let fileName: string | undefined;
  for (const parameter of dispositionParameters(value)) {
    if (parameter.name === "filename*") {
      const extended = decodeExtendedFileName(parameter.value);
      if (extended) {
        return extended;
      }
      continue;
    }
    if (parameter.name === "filename" && parameter.value && fileName === undefined) {
      fileName = parameter.value;
    }
  }
  return fileName;
}

function dispositionParameters(value: string): Array<{ name: string; value: string }> {
  const parameters: Array<{ name: string; value: string }> = [];
  let index = 0;
  while (index < value.length && value[index] !== ";") {
    index += 1;
  }
  while (index < value.length) {
    if (value[index] === ";") {
      index += 1;
    }
    while (value[index] === " " || value[index] === "\t") {
      index += 1;
    }
    const nameStart = index;
    while (index < value.length && value[index] !== "=" && value[index] !== ";") {
      index += 1;
    }
    const name = value.slice(nameStart, index).trim().toLowerCase();
    if (index >= value.length || value[index] !== "=") {
      continue;
    }
    index += 1;
    let parameterValue = "";
    if (value[index] === '"') {
      index += 1;
      while (index < value.length && value[index] !== '"') {
        if (value[index] === "\\" && index + 1 < value.length) {
          index += 1;
        }
        parameterValue += value[index];
        index += 1;
      }
      if (value[index] === '"') {
        index += 1;
      }
    } else {
      const valueStart = index;
      while (index < value.length && value[index] !== ";") {
        index += 1;
      }
      parameterValue = value.slice(valueStart, index).trim();
    }
    if (name) {
      parameters.push({ name, value: parameterValue });
    }
  }
  return parameters;
}

function decodeExtendedFileName(value: string): string | undefined {
  const match = /^([^']*)'[^']*'(.*)$/su.exec(value);
  const charset = match?.[1];
  const encoded = match?.[2];
  if (!charset || encoded === undefined || charset.toLowerCase() !== "utf-8") {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /[\x27()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function toWellFormedFilename(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    result += char.length === 1 && code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : char;
  }
  return result;
}
