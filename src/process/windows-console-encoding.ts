import { spawnSync } from "node:child_process";

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

export function decodeCapturedOutputBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  const utf8 = params.buffer.toString("utf8");
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return utf8;
  }
  const encoding = params.windowsEncoding ?? resolveWindowsConsoleEncoding();
  if (!encoding || encoding.toLowerCase() === "utf-8") {
    return utf8;
  }
  try {
    return new TextDecoder(encoding).decode(params.buffer);
  } catch {
    return utf8;
  }
}
