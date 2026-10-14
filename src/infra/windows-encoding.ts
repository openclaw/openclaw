// Detects Windows console/OEM code pages and decodes console output encodings.
import { spawnSync } from "node:child_process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import iconv from "iconv-lite";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { getWindowsCmdExePath, queryWindowsRegistryValue } from "./windows-install-roots.js";

const WINDOWS_CODEPAGE_ENCODING_MAP: Record<number, string> = {
  65001: "utf-8",
  54936: "gb18030",
  874: "windows-874",
  936: "gbk",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
};
const WINDOWS_ENCODING_PROBE_TIMEOUT_MS = 5_000;

// Task Scheduler launchers use the system OEM page. Interactive consoles can
// override it, so generated scripts also declare this page before their body.
const WINDOWS_NLS_CODEPAGE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage";

const WINDOWS_OEM_CODEPAGE_ENCODING_MAP: Record<number, string> = {
  65001: "utf-8",
  // These locales use the same ANSI/OEM identifier; labels match the ANSI map.
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1258: "windows-1258",
  // OEM-only single-byte pages used by windows-125x ANSI hosts, iconv-lite
  // `cp###` labels. 864 is omitted: real CP864 repurposes ASCII 0x25 "%",
  // which generated cmd scripts contain. Unsupported OEM pages fail closed.
  437: "cp437",
  720: "cp720",
  737: "cp737",
  775: "cp775",
  850: "cp850",
  852: "cp852",
  855: "cp855",
  857: "cp857",
  858: "cp858",
  860: "cp860",
  861: "cp861",
  862: "cp862",
  863: "cp863",
  865: "cp865",
  866: "cp866",
  869: "cp869",
};
const WINDOWS_OEM_ENCODING_CODEPAGE_MAP = new Map(
  Object.entries(WINDOWS_OEM_CODEPAGE_ENCODING_MAP).map(([codePage, encoding]) => [
    encoding,
    Number.parseInt(codePage, 10),
  ]),
);

let cachedWindowsConsoleEncoding: string | null | undefined;
let cachedWindowsSystemEncoding: string | null | undefined;
let cachedWindowsOemCodePage: number | null | undefined;

/** Extracts a Windows console code page number from localized `chcp` output. */
function parseWindowsCodePage(raw: string): number | null {
  const codePage = Number(raw.match(/\b(\d{3,5})\b/)?.[1]);
  return codePage > 0 ? codePage : null;
}

/** Resolves and caches the current Windows console encoding for subprocess output. */
export function resolveWindowsConsoleEncoding(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsConsoleEncoding !== undefined) {
    return cachedWindowsConsoleEncoding;
  }
  // Consoles outside East Asia default to an OEM page (850 on Spanish and
  // German hosts). Those pages are absent from the ANSI map, and Node ICU
  // cannot decode their cp### labels; decoding falls through to iconv-lite.
  cachedWindowsConsoleEncoding = probeWindowsEncoding(
    getWindowsCmdExePath,
    ["/d", "/s", "/c", "chcp"],
    WINDOWS_OEM_CODEPAGE_ENCODING_MAP,
  );
  return cachedWindowsConsoleEncoding;
}

/** Resolves and caches the Windows system encoding used by legacy text files. */
function resolveWindowsSystemEncoding(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsSystemEncoding !== undefined) {
    return cachedWindowsSystemEncoding;
  }
  cachedWindowsSystemEncoding = probeWindowsEncoding(
    () => "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Text.Encoding]::Default.CodePage"],
  );
  return cachedWindowsSystemEncoding;
}

function probeWindowsEncoding(
  command: () => string,
  args: string[],
  fallbackEncodingMap?: Record<number, string>,
): string | null {
  try {
    const result = spawnSync(command(), args, {
      env: resolveDiagnosticProcessEnv(),
      windowsHide: true,
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WINDOWS_ENCODING_PROBE_TIMEOUT_MS,
    });
    const codePage = parseWindowsCodePage(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (codePage === null) {
      return null;
    }
    return WINDOWS_CODEPAGE_ENCODING_MAP[codePage] ?? fallbackEncodingMap?.[codePage] ?? null;
  } catch {
    return null;
  }
}

/** Resolves and caches the boot-time Windows OEM encoding cmd.exe reads batch files with. */
export function resolveWindowsOemEncoding(): string | null {
  const codePage = resolveWindowsOemCodePage();
  return codePage !== null ? (WINDOWS_OEM_CODEPAGE_ENCODING_MAP[codePage] ?? null) : null;
}

/** Resolves and caches the numeric boot-time Windows OEM code page. */
export function resolveWindowsOemCodePage(): number | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsOemCodePage !== undefined) {
    return cachedWindowsOemCodePage;
  }
  const raw = queryWindowsRegistryValue(WINDOWS_NLS_CODEPAGE_KEY, "OEMCP");
  cachedWindowsOemCodePage = raw === null ? null : parseWindowsCodePage(raw);
  return cachedWindowsOemCodePage;
}

/** Returns the numeric Windows OEM page for one resolver encoding label. */
export function resolveWindowsOemCodePageForEncoding(encoding: string): number | null {
  return WINDOWS_OEM_ENCODING_CODEPAGE_MAP.get(encoding) ?? null;
}

/** Decodes one complete subprocess output buffer, preferring valid UTF-8 before legacy code pages. */
export function decodeWindowsOutputBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  return decodeWindowsBufferWithFallback({
    ...params,
    resolveFallbackEncoding: () => params.windowsEncoding ?? resolveWindowsConsoleEncoding(),
  });
}

/** Decodes a text file, preferring valid UTF-8 before the Windows system encoding. */
export function decodeWindowsTextFileBuffer(
  params: Parameters<typeof decodeWindowsOutputBuffer>[0],
): string {
  return (
    decodeUtf16BomBuffer(params.buffer) ??
    decodeWindowsBufferWithFallback({
      ...params,
      resolveFallbackEncoding: () => params.windowsEncoding ?? resolveWindowsSystemEncoding(),
    })
  );
}

function decodeUtf16BomBuffer(buffer: Buffer): string | undefined {
  const [first, second] = buffer;
  return (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff)
    ? new TextDecoder(first === 0xff ? "utf-16le" : "utf-16be").decode(buffer)
    : undefined;
}

function decodeWindowsBufferWithFallback(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  resolveFallbackEncoding: () => string | null;
}): string {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return params.buffer.toString("utf8");
  }

  // Windows PowerShell files and command output can declare UTF-16 with a BOM;
  // honor it before consulting either the system or console legacy code page.
  const utf16 = decodeUtf16BomBuffer(params.buffer);
  if (utf16 !== undefined) {
    return utf16;
  }

  const utf8 = decodeStrictUtf8(params.buffer);
  if (utf8 !== null) {
    return utf8;
  }

  const encoding = params.resolveFallbackEncoding();
  if (!encoding || normalizeLowercaseStringOrEmpty(encoding) === "utf-8") {
    return params.buffer.toString("utf8");
  }
  try {
    return (
      createLegacyTextDecoder(encoding)?.decode(params.buffer) ?? params.buffer.toString("utf8")
    );
  } catch {
    return params.buffer.toString("utf8");
  }
}

type LegacyTextDecoder = {
  decode(buffer?: Buffer, options?: { stream?: boolean }): string;
};

/** Decoder for one legacy code page: Node ICU when it knows the label, iconv-lite for OEM pages. */
function createLegacyTextDecoder(encoding: string): LegacyTextDecoder | null {
  try {
    return new TextDecoder(encoding);
  } catch {
    // Not a WHATWG label. ICU has no cp437/cp850-style OEM pages at all.
  }
  if (!iconv.encodingExists(encoding)) {
    return null;
  }
  const decoder = iconv.getDecoder(encoding);
  return {
    decode(buffer, options) {
      const text = buffer && buffer.length > 0 ? decoder.write(buffer) : "";
      return options?.stream ? text : `${text}${decoder.end() ?? ""}`;
    },
  };
}

/** Creates a streaming decoder for subprocess output chunks that may split multibyte characters. */
export function createWindowsOutputDecoder(params?: {
  platform?: NodeJS.Platform;
  preserveUtf8Bom?: boolean;
  windowsEncoding?: string | null;
}): {
  decode(chunk: Buffer | string): string;
  flush(): string;
} {
  const platform = params?.platform ?? process.platform;
  const encoding =
    platform === "win32" ? (params?.windowsEncoding ?? resolveWindowsConsoleEncoding()) : null;
  const normalizedEncoding = normalizeLowercaseStringOrEmpty(encoding);
  const legacyDecoder =
    platform === "win32" && encoding && normalizedEncoding !== "utf-8"
      ? createLegacyTextDecoder(encoding)
      : null;
  const preserveUtf8Bom = params?.preserveUtf8Bom === true;
  // Starts as strict UTF-8, then becomes the OEM/ANSI decoder after invalid UTF-8.
  let decoder: LegacyTextDecoder = new TextDecoder(
    "utf-8",
    legacyDecoder
      ? {
          fatal: true,
          ...(preserveUtf8Bom ? { ignoreBOM: true } : {}),
        }
      : preserveUtf8Bom
        ? { ignoreBOM: true }
        : undefined,
  );
  let pendingUtf8Bytes = Buffer.alloc(0);
  let pendingBomByte: number | null | undefined = platform === "win32" ? undefined : null;
  let utf16Decoder: TextDecoder | null = null;

  const decodeCurrent = (buffer?: Buffer): string => {
    const options = buffer === undefined ? undefined : { stream: true };
    if (!legacyDecoder || decoder === legacyDecoder) {
      return decoder.decode(buffer, options);
    }
    // Stay on strict UTF-8 until it fails; replay any pending lead bytes through the legacy
    // decoder so split GBK/Big5/etc. characters are not lost at the fallback boundary.
    try {
      const decoded = decoder.decode(buffer, options);
      // Four trailing bytes contain every possible incomplete UTF-8 sequence.
      const trailingBuffer =
        buffer && buffer.length < 4 && pendingUtf8Bytes.length > 0
          ? Buffer.concat([pendingUtf8Bytes, buffer])
          : buffer;
      pendingUtf8Bytes = trailingBuffer
        ? Buffer.from(getTrailingIncompleteUtf8Bytes(trailingBuffer))
        : Buffer.alloc(0);
      return decoded;
    } catch {
      const replayBuffer =
        buffer === undefined
          ? pendingUtf8Bytes
          : pendingUtf8Bytes.length > 0
            ? Buffer.concat([pendingUtf8Bytes, buffer])
            : buffer;
      decoder = legacyDecoder;
      pendingUtf8Bytes = Buffer.alloc(0);
      return buffer !== undefined || replayBuffer.length > 0
        ? legacyDecoder.decode(replayBuffer, options)
        : "";
    }
  };

  return {
    decode(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (utf16Decoder) {
        return utf16Decoder.decode(buffer, { stream: true });
      }
      if (pendingBomByte === null || buffer.length === 0) {
        return pendingBomByte === null ? decodeCurrent(buffer) : "";
      }

      const candidate =
        pendingBomByte === undefined
          ? buffer
          : Buffer.concat([Buffer.from([pendingBomByte]), buffer]);
      const [first, second] = candidate;
      // Delay only an ambiguous UTF-16 lead byte; replay non-matches unchanged.
      if (second === undefined && (first === 0xff || first === 0xfe)) {
        pendingBomByte = first;
        return "";
      }
      pendingBomByte = null;
      if ((first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff)) {
        utf16Decoder = new TextDecoder(first === 0xff ? "utf-16le" : "utf-16be");
        return utf16Decoder.decode(candidate, { stream: true });
      }
      return decodeCurrent(candidate);
    },
    flush() {
      if (utf16Decoder) {
        return utf16Decoder.decode();
      }
      const pending = typeof pendingBomByte === "number" ? Buffer.from([pendingBomByte]) : null;
      pendingBomByte = null;
      return (pending ? decodeCurrent(pending) : "") + decodeCurrent();
    },
  };
}

function getTrailingIncompleteUtf8Bytes(buffer: Buffer): Buffer {
  let index = buffer.length - 1;
  let continuationBytes = 0;
  while (index >= 0 && continuationBytes < 3) {
    const byte = buffer.readUInt8(index);
    if (byte < 0x80 || byte > 0xbf) {
      break;
    }
    continuationBytes += 1;
    index -= 1;
  }
  if (index < 0) {
    return buffer;
  }

  const sequenceLength = getUtf8SequenceLength(buffer.readUInt8(index));
  if (sequenceLength <= 1) {
    return Buffer.alloc(0);
  }

  const availableBytes = continuationBytes + 1;
  return availableBytes < sequenceLength ? buffer.subarray(index) : Buffer.alloc(0);
}

function getUtf8SequenceLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) {
    return 2;
  }
  if (byte >= 0xe0 && byte <= 0xef) {
    return 3;
  }
  if (byte >= 0xf0 && byte <= 0xf4) {
    return 4;
  }
  return 1;
}

function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
