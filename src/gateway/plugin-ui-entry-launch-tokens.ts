import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { canonicalizePathForSecurity } from "./security-path.js";

const PLUGIN_UI_ENTRY_LAUNCH_TOKEN_PARAM = "__openclaw_plugin_entry";
const PLUGIN_UI_ENTRY_SESSION_COOKIE = "openclaw_plugin_entry";
export const PLUGIN_UI_ENTRY_SESSION_KEY_HEADER = "x-openclaw-plugin-ui-session-key";
export const PLUGIN_UI_ENTRY_CONTEXT_TOKENS_HEADER = "x-openclaw-plugin-ui-context-tokens";

const TOKEN_TTL_MS = 60_000;
const SESSION_TTL_MS = 10 * 60_000;
const MAX_TOKENS = 256;
const MAX_SESSIONS = 256;

type LaunchTokenRecord = {
  canonicalPath: string;
  canonicalPathRoot: string;
  expiresAtMs: number;
  path: string;
  scopes: string[];
  sessionKey?: string;
  contextTokens?: number;
};

type SessionTokenRecord = {
  canonicalPathRoot: string;
  expiresAtMs: number;
  pathRoot: string;
  scopes: string[];
  sessionKey?: string;
  contextTokens?: number;
};

const launchTokens = new Map<string, LaunchTokenRecord>();
const sessionTokens = new Map<string, SessionTokenRecord>();

function pruneExpiredTokens(nowMs: number): void {
  for (const [token, record] of launchTokens) {
    if (record.expiresAtMs <= nowMs) {
      launchTokens.delete(token);
    }
  }
  while (launchTokens.size > MAX_TOKENS) {
    const oldest = launchTokens.keys().next().value;
    if (!oldest) {
      return;
    }
    launchTokens.delete(oldest);
  }
  for (const [token, record] of sessionTokens) {
    if (record.expiresAtMs <= nowMs) {
      sessionTokens.delete(token);
    }
  }
  while (sessionTokens.size > MAX_SESSIONS) {
    const oldest = sessionTokens.keys().next().value;
    if (!oldest) {
      return;
    }
    sessionTokens.delete(oldest);
  }
}

function appendTokenToPath(path: string, token: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${PLUGIN_UI_ENTRY_LAUNCH_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

function resolvePluginUiSessionPathRoot(path: string): string | undefined {
  const canonical = canonicalizePathForSecurity(path.split(/[?#]/, 1)[0] ?? "");
  if (canonical.malformedEncoding || canonical.decodePassLimitReached) {
    return undefined;
  }
  const pathname = canonical.canonicalPath;
  if (!pathname.startsWith("/plugins/")) {
    return undefined;
  }
  const [firstSegment, secondSegment] = pathname.slice("/plugins/".length).split("/");
  if (!firstSegment) {
    return undefined;
  }
  const pluginPath = firstSegment.startsWith("@")
    ? secondSegment
      ? `${firstSegment}/${secondSegment}`
      : undefined
    : firstSegment;
  if (!pluginPath) {
    return undefined;
  }
  return `/plugins/${pluginPath}`;
}

function matchesCanonicalPluginUiRoot(params: { path: string; pathRoot: string }): boolean {
  const canonical = canonicalizePathForSecurity(params.path);
  if (canonical.malformedEncoding || canonical.decodePassLimitReached) {
    return false;
  }
  return canonical.candidates.every(
    (candidate) => candidate === params.pathRoot || candidate.startsWith(`${params.pathRoot}/`),
  );
}

function resolvePluginUiEntryCanonicalPath(path: string): string | undefined {
  const canonical = canonicalizePathForSecurity(path.split(/[?#]/, 1)[0] ?? "");
  if (
    canonical.malformedEncoding ||
    canonical.decodePassLimitReached ||
    !canonical.candidates.every((candidate) => candidate === canonical.canonicalPath)
  ) {
    return undefined;
  }
  return canonical.canonicalPath;
}

function matchesPluginUiSessionPath(params: { path: string; pathRoot: string }): boolean {
  return matchesCanonicalPluginUiRoot(params);
}

function parseCookieHeader(header: string | string[] | undefined): Map<string, string> {
  const raw = Array.isArray(header) ? header.join("; ") : (header ?? "");
  const cookies = new Map<string, string>();
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    try {
      cookies.set(trimmed.slice(0, separator), decodeURIComponent(trimmed.slice(separator + 1)));
    } catch {
      continue;
    }
  }
  return cookies;
}

function issuePluginUiEntryPointSession(params: {
  path: string;
  scopes: readonly string[];
  sessionKey?: string;
  contextTokens?: number;
  nowMs: number;
}): { cookieHeader: string } | undefined {
  const pathRoot = resolvePluginUiSessionPathRoot(params.path);
  if (!pathRoot) {
    return undefined;
  }
  const token = randomUUID();
  sessionTokens.set(token, {
    canonicalPathRoot: pathRoot,
    expiresAtMs: params.nowMs + SESSION_TTL_MS,
    pathRoot,
    scopes: [...params.scopes],
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.contextTokens ? { contextTokens: params.contextTokens } : {}),
  });
  return {
    cookieHeader: [
      `${PLUGIN_UI_ENTRY_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      `Path=${pathRoot}`,
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      "HttpOnly",
      "SameSite=Lax",
    ].join("; "),
  };
}

export function issuePluginUiEntryPointLaunchPath(params: {
  path: string;
  scopes: readonly string[];
  sessionKey?: string;
  contextTokens?: number;
  ttlMs?: number;
  nowMs?: number;
}): string {
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredTokens(nowMs);
  const canonicalPath = resolvePluginUiEntryCanonicalPath(params.path);
  const canonicalPathRoot = canonicalPath
    ? resolvePluginUiSessionPathRoot(canonicalPath)
    : undefined;
  if (!canonicalPath || !canonicalPathRoot) {
    throw new Error("plugin UI entry launch path must be a canonical plugin-owned route path");
  }
  const token = randomUUID();
  const ttlMs =
    typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs)
      ? Math.max(1_000, Math.min(params.ttlMs, SESSION_TTL_MS))
      : TOKEN_TTL_MS;
  launchTokens.set(token, {
    canonicalPath,
    canonicalPathRoot,
    expiresAtMs: nowMs + ttlMs,
    path: params.path,
    scopes: [...params.scopes],
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.contextTokens ? { contextTokens: params.contextTokens } : {}),
  });
  return appendTokenToPath(params.path, token);
}

export function consumePluginUiEntryPointLaunchToken(params: {
  req: IncomingMessage;
  path: string;
  nowMs?: number;
}):
  | {
      ok: true;
      scopes: string[];
      setCookieHeader?: string;
      sessionKey?: string;
      contextTokens?: number;
    }
  | { ok: false } {
  const url = new URL(params.req.url ?? "/", "http://localhost");
  const token = url.searchParams.get(PLUGIN_UI_ENTRY_LAUNCH_TOKEN_PARAM);
  if (!token) {
    return { ok: false };
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredTokens(nowMs);
  const record = launchTokens.get(token);
  launchTokens.delete(token);
  const canonicalPath = resolvePluginUiEntryCanonicalPath(params.path);
  if (
    !record ||
    record.expiresAtMs <= nowMs ||
    canonicalPath !== record.canonicalPath ||
    !matchesCanonicalPluginUiRoot({ path: params.path, pathRoot: record.canonicalPathRoot })
  ) {
    return { ok: false };
  }
  const session = issuePluginUiEntryPointSession({
    path: record.path,
    scopes: record.scopes,
    sessionKey: record.sessionKey,
    contextTokens: record.contextTokens,
    nowMs,
  });
  return {
    ok: true,
    scopes: [...record.scopes],
    ...(record.sessionKey ? { sessionKey: record.sessionKey } : {}),
    ...(record.contextTokens ? { contextTokens: record.contextTokens } : {}),
    ...(session ? { setCookieHeader: session.cookieHeader } : {}),
  };
}

export function resolvePluginUiEntryPointSessionCookie(params: {
  req: IncomingMessage;
  path: string;
  nowMs?: number;
}): { ok: true; scopes: string[]; sessionKey?: string; contextTokens?: number } | { ok: false } {
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredTokens(nowMs);
  const cookies = parseCookieHeader(params.req.headers.cookie);
  const token = cookies.get(PLUGIN_UI_ENTRY_SESSION_COOKIE);
  if (!token) {
    return { ok: false };
  }
  const record = sessionTokens.get(token);
  if (
    !record ||
    record.expiresAtMs <= nowMs ||
    !matchesPluginUiSessionPath({ path: params.path, pathRoot: record.canonicalPathRoot })
  ) {
    if (record?.expiresAtMs !== undefined && record.expiresAtMs <= nowMs) {
      sessionTokens.delete(token);
    }
    return { ok: false };
  }
  return {
    ok: true,
    scopes: [...record.scopes],
    ...(record.sessionKey ? { sessionKey: record.sessionKey } : {}),
    ...(record.contextTokens ? { contextTokens: record.contextTokens } : {}),
  };
}
