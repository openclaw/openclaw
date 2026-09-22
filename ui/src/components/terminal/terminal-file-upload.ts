import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type {
  TerminalUploadPathStyle,
  TerminalUploadResult,
} from "../../../../packages/gateway-protocol/src/schema/terminal.ts";
import { t } from "../../i18n/index.ts";

// Keep this client guard aligned with the gateway protocol's 16 MiB limit so
// oversized files never expand into a WebSocket base64 payload.
const MAX_TERMINAL_UPLOAD_BYTES = 16 * 1024 * 1024;

type TerminalUploadFile = { name: string; contentBase64: string };

type TerminalUploadClient = {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
};

export async function uploadTerminalFile(
  client: TerminalUploadClient,
  sessionId: string,
  file: TerminalUploadFile,
  signal?: AbortSignal,
): Promise<TerminalUploadResult> {
  const params = { sessionId, ...file };
  return await (signal
    ? client.request<TerminalUploadResult>("terminal.upload", params, { signal })
    : client.request<TerminalUploadResult>("terminal.upload", params));
}

export async function encodeTerminalUpload(file: File): Promise<string> {
  if (file.size > MAX_TERMINAL_UPLOAD_BYTES) {
    throw new Error(t("terminal.uploadTooLarge", { file: file.name }));
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function quotePosixUploadPath(filePath: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(filePath)) {
    return filePath;
  }
  return `'${filePath.replaceAll("'", "'\\''")}'`;
}

/** Uses the admitted receiver's path contract, keeping shell checks intact. */
export function quoteTerminalUploadPath(
  filePath: string,
  shell: string,
  uploadPathStyle?: TerminalUploadPathStyle,
): string {
  if (uploadPathStyle === "native") {
    if (containsAsciiControlCharacter(filePath)) {
      throw new Error(t("terminal.uploadInvalidNativePath"));
    }
    if (/^(?:[a-z]:[\\/]|\\\\)/iu.test(filePath)) {
      if (filePath.includes('"')) {
        throw new Error(t("terminal.uploadInvalidNativePath"));
      }
      // Native CLI parsers recognize Windows paths before POSIX unescaping.
      return `"${filePath}"`;
    }
    if (!filePath.startsWith("/")) {
      throw new Error(t("terminal.uploadInvalidNativePath"));
    }
    // Native path readers remove outer quotes and backslash escapes, not shell quote concatenation.
    return `"${filePath.replace(/[\\"$`]/gu, "\\$&")}"`;
  }
  const shellName = shell.split(/[\\/]/u).pop()?.toLowerCase() ?? "";
  if (/^(?:pwsh|powershell)(?:\.exe)?$/u.test(shellName)) {
    return `'${filePath.replaceAll("'", "''")}'`;
  }
  if (/^cmd(?:\.exe)?$/u.test(shellName)) {
    if (/[%!]/u.test(filePath)) {
      throw new Error(t("terminal.uploadUnsafeCmdPath"));
    }
    return `"${filePath.replaceAll('"', '""')}"`;
  }
  const posixShell = /^(?:(?:ba|da|a|k|z)?sh|fish)(?:\.exe)?$/u.test(shellName);
  if (!posixShell) {
    throw new Error(t("terminal.uploadUnsupportedShell", { shell: shellName || shell }));
  }
  return quotePosixUploadPath(filePath);
}
