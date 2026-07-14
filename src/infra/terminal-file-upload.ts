import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
} from "../../packages/gateway-protocol/src/terminal-upload-constants.js";
import { logWarn } from "../logger.js";

const TERMINAL_UPLOAD_PREFIX = "openclaw-terminal-upload-";
const TERMINAL_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const TERMINAL_UPLOAD_CLEANUP_RETRY_MS = 60 * 60 * 1000;
const MAX_STAGED_NAME_BYTES = 180;
const PORTABLE_NAME_FORBIDDEN = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*", "%", "!"]);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let defaultCleanupStarted = false;

export type TerminalUploadFile = {
  name: string;
  contentBase64: string;
};

export type TerminalUploadResult = {
  path: string;
  size: number;
};

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += nextBytes;
  }
  return result;
}

export function sanitizeTerminalUploadName(name: string): string {
  const basename = path.posix.basename(name.replaceAll("\\", "/"));
  const cleaned = Array.from(basename, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || PORTABLE_NAME_FORBIDDEN.has(char)
      ? "_"
      : char;
  })
    .join("")
    .trim()
    .replace(/[. ]+$/u, "");
  const portable = WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
  const safe = portable && portable !== "." && portable !== ".." ? portable : "upload";
  return truncateUtf8(safe, MAX_STAGED_NAME_BYTES) || "upload";
}

function decodeTerminalUpload(contentBase64: string): Buffer {
  if (
    contentBase64.length > MAX_TERMINAL_UPLOAD_BASE64_LENGTH ||
    terminalUploadDecodedSize(contentBase64) > MAX_TERMINAL_UPLOAD_BYTES
  ) {
    throw new Error(`terminal upload exceeds ${MAX_TERMINAL_UPLOAD_BYTES} bytes`);
  }
  if (!isCanonicalTerminalUploadBase64(contentBase64)) {
    throw new Error("invalid terminal upload encoding");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length > MAX_TERMINAL_UPLOAD_BYTES) {
    throw new Error(`terminal upload exceeds ${MAX_TERMINAL_UPLOAD_BYTES} bytes`);
  }
  if (bytes.toString("base64") !== contentBase64) {
    throw new Error("invalid terminal upload encoding");
  }
  return bytes;
}

export function isCanonicalTerminalUploadBase64(contentBase64: string): boolean {
  if (
    contentBase64.length > MAX_TERMINAL_UPLOAD_BASE64_LENGTH ||
    contentBase64.length % 4 !== 0 ||
    terminalUploadDecodedSize(contentBase64) > MAX_TERMINAL_UPLOAD_BYTES
  ) {
    return false;
  }
  const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  const dataEnd = contentBase64.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    const code = contentBase64.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) {
      return false;
    }
  }
  for (let index = dataEnd; index < contentBase64.length; index += 1) {
    if (contentBase64.charCodeAt(index) !== 61) {
      return false;
    }
  }
  return true;
}

function terminalUploadDecodedSize(contentBase64: string): number {
  if (contentBase64.length === 0) {
    return 0;
  }
  const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  return Math.floor(contentBase64.length / 4) * 3 - padding;
}

async function removeTerminalUploadDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    logWarn(`terminal-upload: cleanup failed; retrying: ${String(error)}`);
    scheduleTerminalUploadCleanup(directory, TERMINAL_UPLOAD_CLEANUP_RETRY_MS);
  }
}

function scheduleTerminalUploadCleanup(directory: string, afterMs: number): void {
  if (cleanupTimers.has(directory)) {
    return;
  }
  const timer = setTimeout(
    () => {
      cleanupTimers.delete(directory);
      void removeTerminalUploadDirectory(directory);
    },
    Math.max(0, afterMs),
  );
  cleanupTimers.set(directory, timer);
  timer.unref?.();
}

/** Restores cleanup timers for staged uploads left by a previous process. */
export async function recoverTerminalUploadCleanup(options?: {
  tempRoot?: string;
  retentionMs?: number;
  nowMs?: number;
}): Promise<void> {
  const tempRoot = options?.tempRoot ?? tmpdir();
  const retentionMs = options?.retentionMs ?? TERMINAL_UPLOAD_RETENTION_MS;
  const nowMs = options?.nowMs ?? Date.now();
  let entries;
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn(`terminal-upload: recovery scan failed: ${String(error)}`);
    }
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TERMINAL_UPLOAD_PREFIX))
      .map(async (entry) => {
        const directory = path.join(tempRoot, entry.name);
        try {
          const stats = await lstat(directory);
          if (!stats.isDirectory()) {
            return;
          }
          if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
            return;
          }
          const remainingMs = retentionMs - Math.max(0, nowMs - stats.mtimeMs);
          if (remainingMs <= 0) {
            await removeTerminalUploadDirectory(directory);
          } else {
            scheduleTerminalUploadCleanup(directory, remainingMs);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logWarn(`terminal-upload: recovery failed: ${String(error)}`);
          }
        }
      }),
  );
}

/** Starts one process-wide recovery scan; per-directory timers are unref'd. */
export function ensureTerminalUploadCleanup(): void {
  if (defaultCleanupStarted) {
    return;
  }
  defaultCleanupStarted = true;
  void recoverTerminalUploadCleanup();
}

/** Stages one browser-selected file in a private, expiring temporary directory. */
export async function stageTerminalUpload(
  file: TerminalUploadFile,
  options?: { tempRoot?: string; cleanupAfterMs?: number },
): Promise<TerminalUploadResult> {
  if (!options?.tempRoot) {
    ensureTerminalUploadCleanup();
  }
  const bytes = decodeTerminalUpload(file.contentBase64);
  const directory = await mkdtemp(path.join(options?.tempRoot ?? tmpdir(), TERMINAL_UPLOAD_PREFIX));
  const targetPath = path.join(directory, sanitizeTerminalUploadName(file.name));
  try {
    await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  scheduleTerminalUploadCleanup(directory, options?.cleanupAfterMs ?? TERMINAL_UPLOAD_RETENTION_MS);
  return { path: targetPath, size: bytes.length };
}
