import { homedir } from "node:os";
import path from "node:path";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";
import { parseBooleanValue } from "../../utils/boolean.js";

/**
 * Extract profile name from query string or body and get profile context.
 * Query string takes precedence over body for consistency with GET routes.
 */
export function getProfileContext(
  req: BrowserRequest,
  ctx: BrowserRouteContext,
): ProfileContext | { error: string; status: number } {
  let profileName: string | undefined;

  // Check query string first (works for GET and POST)
  if (typeof req.query.profile === "string") {
    profileName = req.query.profile.trim() || undefined;
  }

  // Fall back to body for POST requests
  if (!profileName && req.body && typeof req.body === "object") {
    const body = req.body as Record<string, unknown>;
    if (typeof body.profile === "string") {
      profileName = body.profile.trim() || undefined;
    }
  }

  try {
    return ctx.forProfile(profileName);
  } catch (err) {
    return { error: String(err), status: 404 };
  }
}

export function jsonError(res: BrowserResponse, status: number, message: string) {
  res.status(status).json({ error: message });
}

export function toStringOrEmpty(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return "";
}

export function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function toBoolean(value: unknown) {
  return parseBooleanValue(value, {
    truthy: ["true", "1", "yes"],
    falsy: ["false", "0", "no"],
  });
}

export function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.map((v) => toStringOrEmpty(v)).filter(Boolean);
  return strings.length ? strings : undefined;
}

/**
 * Validates that a file path is within allowed directories.
 * Prevents path traversal attacks (CWE-22) by ensuring paths
 * cannot escape the user's home directory or current working directory.
 *
 * @returns null if valid, error message if invalid
 */
export function validateBrowserFilePath(filePath: string): string | null {
  if (!filePath) {
    return "path is required";
  }

  const resolved = path.resolve(filePath);
  const home = homedir();
  const cwd = process.cwd();

  // Allow paths within home directory or current working directory
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  const cwdWithSep = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;

  const isWithinHome = resolved === home || resolved.startsWith(homeWithSep);
  const isWithinCwd = resolved === cwd || resolved.startsWith(cwdWithSep);

  if (!isWithinHome && !isWithinCwd) {
    return "path must be within home directory or current working directory";
  }

  // Block paths that contain traversal patterns even if resolved
  const normalized = path.normalize(filePath);
  if (normalized.includes("..")) {
    return "path traversal not allowed";
  }

  return null;
}

/**
 * Validates an array of file paths for browser file upload.
 * @returns null if all valid, error message if any invalid
 */
export function validateBrowserFilePaths(paths: string[]): string | null {
  for (const p of paths) {
    const error = validateBrowserFilePath(p);
    if (error) {
      return `${error}: ${p}`;
    }
  }
  return null;
}
