import fs from "node:fs";
import { resolveUserPath } from "../utils.js";
import { openVerifiedFileSync } from "./safe-open-sync.js";

export const DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;

export type SecretFileReadOptions = {
  maxBytes?: number;
  rejectSymlink?: boolean;
};

export type SecretFileReadResult =
  | {
      ok: true;
      secret: string;
      resolvedPath: string;
    }
  | {
      ok: false;
      message: string;
      resolvedPath?: string;
      error?: unknown;
    };

export function loadSecretFileSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): SecretFileReadResult {
  const trimmedPath = filePath.trim();
  const resolvedPath = resolveUserPath(trimmedPath);
  if (!resolvedPath) {
    return { ok: false, message: `${label} file path is empty.` };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_SECRET_FILE_MAX_BYTES;

  let previewStat: fs.Stats;
  try {
    previewStat = fs.lstatSync(resolvedPath);
  } catch (error) {
    return {
      ok: false,
      resolvedPath,
      error,
      message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(error)}`,
    };
  }

  if (options.rejectSymlink && previewStat.isSymbolicLink()) {
    return {
      ok: false,
      resolvedPath,
      message: `${label} file at ${resolvedPath} must not be a symlink.`,
    };
  }
  if (!previewStat.isFile()) {
    return {
      ok: false,
      resolvedPath,
      message: `${label} file at ${resolvedPath} must be a regular file.`,
    };
  }
  if (previewStat.size > maxBytes) {
    return {
      ok: false,
      resolvedPath,
      message: `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.`,
    };
  }

  const opened = openVerifiedFileSync({
    filePath: resolvedPath,
    rejectPathSymlink: options.rejectSymlink,
    maxBytes,
  });
  if (!opened.ok) {
    const error =
      opened.reason === "validation" ? new Error("security validation failed") : opened.error;
    return {
      ok: false,
      resolvedPath,
      error,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`,
    };
  }

  try {
    const raw = fs.readFileSync(opened.fd, "utf8");
    const secret = raw.trim();
    if (!secret) {
      return {
        ok: false,
        resolvedPath,
        message: `${label} file at ${resolvedPath} is empty.`,
      };
    }
    return { ok: true, secret, resolvedPath };
  } catch (error) {
    return {
      ok: false,
      resolvedPath,
      error,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function readSecretFileSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): string {
  const result = loadSecretFileSync(filePath, label, options);
  if (result.ok) {
    return result.secret;
  }
  throw new Error(result.message, result.error ? { cause: result.error } : undefined);
}

export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options: SecretFileReadOptions = {},
): string | undefined {
  if (!filePath?.trim()) {
    return undefined;
  }
  const result = loadSecretFileSync(filePath, label, options);
  return result.ok ? result.secret : undefined;
}
