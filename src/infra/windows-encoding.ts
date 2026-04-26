import { spawnSync } from "node:child_process";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const WINDOWS_CODEPAGE_ENCODING_MAP: Record<number, string> = {
  65001: "utf-8",
  54936: "gb18030",
  936: "gbk",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1252: "windows-1252",
};

let cachedWindowsConsoleEncoding: string | null | undefined;

export function parseWindowsCodePage(raw: string): number | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(/\b(\d{3,5})\b/);
  if (!match?.[1]) {
    return null;
  }
  const codePage = Number.parseInt(match[1], 10);
  if (!Number.isFinite(codePage) || codePage <= 0) {
    return null;
  }
  return codePage;
}

export function resolveWindowsConsoleEncoding(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsConsoleEncoding !== undefined) {
    return cachedWindowsConsoleEncoding;
  }
  try {
    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "chcp"], {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const codePage = parseWindowsCodePage(raw);
    cachedWindowsConsoleEncoding =
      codePage !== null ? (WINDOWS_CODEPAGE_ENCODING_MAP[codePage] ?? null) : null;
  } catch {
    cachedWindowsConsoleEncoding = null;
  }
  return cachedWindowsConsoleEncoding;
}

export function decodeWindowsOutputBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return params.buffer.toString("utf8");
  }

  const utf8 = decodeStrictUtf8(params.buffer);
  if (utf8 !== null) {
    return utf8;
  }

  const encoding = params.windowsEncoding ?? resolveWindowsConsoleEncoding();
  if (!encoding || normalizeLowercaseStringOrEmpty(encoding) === "utf-8") {
    return params.buffer.toString("utf8");
  }
  try {
    return new TextDecoder(encoding).decode(params.buffer);
  } catch {
    return params.buffer.toString("utf8");
  }
}

export function createWindowsOutputDecoder(params?: {
  platform?: NodeJS.Platform;
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
      ? new TextDecoder(encoding)
      : null;
  const utf8Decoder =
    platform === "win32" && legacyDecoder ? new TextDecoder("utf-8", { fatal: true }) : null;
  let useLegacyDecoder = false;

  return {
    decode(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!legacyDecoder || !utf8Decoder) {
        return buffer.toString("utf8");
      }
      if (useLegacyDecoder) {
        return legacyDecoder.decode(buffer, { stream: true });
      }
      try {
        return utf8Decoder.decode(buffer, { stream: true });
      } catch {
        useLegacyDecoder = true;
        return legacyDecoder.decode(buffer, { stream: true });
      }
    },
    flush() {
      if (!legacyDecoder || !utf8Decoder) {
        return "";
      }
      if (useLegacyDecoder) {
        return legacyDecoder.decode();
      }
      try {
        return utf8Decoder.decode();
      } catch {
        return "";
      }
    },
  };
}

function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
