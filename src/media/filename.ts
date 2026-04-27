import path from "node:path";

const REPLACEMENT_CHAR = "\uFFFD";
const PERCENT_BYTE_RE = /%[0-9a-f]{2}/i;
const LATIN1_MOJIBAKE_MARKER_RE = /[\u0080-\u00FF]/u;
const NON_LATIN_SCRIPT_RE = /[\u0100-\uFFFF]/u;
const WINDOWS_1252_BYTES = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

export function basenameFromUntrustedFilename(value: string): string | undefined {
  let base = path.posix.basename(value.trim());
  base = path.win32.basename(base);
  let cleaned = "";
  for (const char of base) {
    const code = char.charCodeAt(0);
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      continue;
    }
    cleaned += char;
  }
  cleaned = cleaned.trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return undefined;
  }
  return cleaned;
}

export function recoverLatin1Utf8Mojibake(value: string): string {
  if (!LATIN1_MOJIBAKE_MARKER_RE.test(value)) {
    return value;
  }
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.charCodeAt(0);
    const windows1252Byte = WINDOWS_1252_BYTES.get(code);
    if (windows1252Byte !== undefined) {
      bytes.push(windows1252Byte);
    } else if (code <= 0xff) {
      bytes.push(code);
    } else {
      return value;
    }
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  if (decoded.includes(REPLACEMENT_CHAR)) {
    return value;
  }
  if (!NON_LATIN_SCRIPT_RE.test(decoded)) {
    return value;
  }
  return decoded;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitHeaderParameters(header: string): Map<string, string> {
  const params = new Map<string, string>();
  let current = "";
  let quoted = false;
  let escaped = false;
  const parts: string[] = [];

  for (const char of header) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!key || params.has(key)) {
      continue;
    }
    params.set(key, part.slice(eq + 1).trim());
  }

  return params;
}

function decodePercentBytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "%" && i + 2 < value.length) {
      const hex = value.slice(i + 1, i + 3);
      const byte = Number.parseInt(hex, 16);
      if (/^[0-9a-f]{2}$/i.test(hex) && Number.isFinite(byte)) {
        bytes.push(byte);
        i += 2;
        continue;
      }
    }
    bytes.push(...Buffer.from(char, "utf8"));
  }
  return Uint8Array.from(bytes);
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const normalized = charset.trim().toLowerCase();
  const labels: Record<string, string> = {
    gbk: "gb18030",
    gb2312: "gb18030",
    "shift-jis": "shift_jis",
    sjis: "shift_jis",
    "euc-kr": "euc-kr",
    euckr: "euc-kr",
  };
  const label = labels[normalized] ?? normalized;
  return new TextDecoder(label, { fatal: true }).decode(bytes);
}

function decodeRfc5987Value(value: string): string | undefined {
  const cleaned = stripQuotes(value);
  const firstTick = cleaned.indexOf("'");
  const secondTick = firstTick === -1 ? -1 : cleaned.indexOf("'", firstTick + 1);
  if (firstTick === -1 || secondTick === -1) {
    return undefined;
  }
  const charset = cleaned.slice(0, firstTick);
  const encoded = cleaned.slice(secondTick + 1);
  if (!charset || !encoded) {
    return undefined;
  }
  try {
    return decodeBytes(decodePercentBytes(encoded), charset);
  } catch {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
}

function decodePlainFilenameValue(value: string): string {
  const cleaned = stripQuotes(value);
  if (PERCENT_BYTE_RE.test(cleaned)) {
    try {
      return decodeURIComponent(cleaned);
    } catch {
      // Fall through to mojibake recovery.
    }
  }
  return recoverLatin1Utf8Mojibake(cleaned);
}

export function decodeContentDispositionFilename(header?: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const params = splitHeaderParameters(header);
  const star = params.get("filename*");
  if (star) {
    const decoded = decodeRfc5987Value(star);
    const base = decoded ? basenameFromUntrustedFilename(decoded) : undefined;
    if (base) {
      return base;
    }
  }
  const plain = params.get("filename");
  if (!plain) {
    return undefined;
  }
  return basenameFromUntrustedFilename(decodePlainFilenameValue(plain));
}
