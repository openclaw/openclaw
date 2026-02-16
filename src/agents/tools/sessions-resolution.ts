import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { isAcpSessionKey, normalizeMainKey } from "../../routing/session-key.js";

function normalizeKey(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveMainSessionAlias(cfg: OpenClawConfig) {
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const alias = scope === "global" ? "global" : mainKey;
  return { mainKey, alias, scope };
}

export function resolveDisplaySessionKey(params: { key: string; alias: string; mainKey: string }) {
  if (params.key === params.alias) {
    return "main";
  }
  if (params.key === params.mainKey) {
    return "main";
  }
  return params.key;
}

export function resolveInternalSessionKey(params: { key: string; alias: string; mainKey: string }) {
  if (params.key === "main") {
    return params.alias;
  }
  return params.key;
}

export async function listSpawnedSessionKeys(params: {
  requesterSessionKey: string;
  limit?: number;
}): Promise<Set<string>> {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : 500;
  try {
    const list = await callGateway<{ sessions: Array<{ key?: unknown }> }>({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        limit,
        spawnedBy: params.requesterSessionKey,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const keys = sessions
      .map((entry) => (typeof entry?.key === "string" ? entry.key : ""))
      .map((value) => value.trim())
      .filter(Boolean);
    return new Set(keys);
  } catch {
    return new Set();
  }
}

export async function isRequesterSpawnedSessionVisible(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  limit?: number;
}): Promise<boolean> {
  if (params.requesterSessionKey === params.targetSessionKey) {
    return true;
  }
  const keys = await listSpawnedSessionKeys({
    requesterSessionKey: params.requesterSessionKey,
    limit: params.limit,
  });
  return keys.has(params.targetSessionKey);
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value.trim());
}

export function looksLikeSessionKey(value: string): boolean {
  const raw = value.trim();
  if (!raw) {
    return false;
  }
  // These are canonical key shapes that should never be treated as sessionIds.
  if (raw === "main" || raw === "global" || raw === "unknown") {
    return true;
  }
  if (isAcpSessionKey(raw)) {
    return true;
  }
  if (raw.startsWith("agent:")) {
    return true;
  }
  if (raw.startsWith("cron:") || raw.startsWith("hook:")) {
    return true;
  }
  if (raw.startsWith("node-") || raw.startsWith("node:")) {
    return true;
  }
  if (raw.includes(":group:") || raw.includes(":channel:")) {
    return true;
  }
  return false;
}

export function shouldResolveSessionIdInput(value: string): boolean {
  // Treat anything that doesn't look like a well-formed key as a sessionId candidate.
  return looksLikeSessionId(value) || !looksLikeSessionKey(value);
}

export type SessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
      resolvedViaSessionId: boolean;
    }
  | { ok: false; status: "error" | "forbidden"; error: string };

async function resolveSessionKeyFromSessionId(params: {
  sessionId: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution> {
  try {
    // Resolve via gateway so we respect store routing and visibility rules.
    const result = await callGateway<{ key?: string }>({
      method: "sessions.resolve",
      params: {
        sessionId: params.sessionId,
        spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
        includeGlobal: !params.restrictToSpawned,
        includeUnknown: !params.restrictToSpawned,
      },
    });
    const key = typeof result?.key === "string" ? result.key.trim() : "";
    if (!key) {
      throw new Error(
        `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
      );
    }
    return {
      ok: true,
      key,
      displayKey: resolveDisplaySessionKey({
        key,
        alias: params.alias,
        mainKey: params.mainKey,
      }),
      resolvedViaSessionId: true,
    };
  } catch (err) {
    if (params.restrictToSpawned) {
      return {
        ok: false,
        status: "forbidden",
        error: `Session not visible from this sandboxed agent session: ${params.sessionId}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: "error",
      error:
        message ||
        `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
    };
  }
}

async function resolveSessionKeyFromKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution | null> {
  try {
    // Try key-based resolution first so non-standard keys keep working.
    const result = await callGateway<{ key?: string }>({
      method: "sessions.resolve",
      params: {
        key: params.key,
        spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
      },
    });
    const key = typeof result?.key === "string" ? result.key.trim() : "";
    if (!key) {
      return null;
    }
    return {
      ok: true,
      key,
      displayKey: resolveDisplaySessionKey({
        key,
        alias: params.alias,
        mainKey: params.mainKey,
      }),
      resolvedViaSessionId: false,
    };
  } catch {
    return null;
  }
}

export async function resolveSessionReference(params: {
  sessionKey: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution> {
  const raw = params.sessionKey.trim();
  if (shouldResolveSessionIdInput(raw)) {
    // Prefer key resolution to avoid misclassifying custom keys as sessionIds.
    const resolvedByKey = await resolveSessionKeyFromKey({
      key: raw,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
    });
    if (resolvedByKey) {
      return resolvedByKey;
    }
    return await resolveSessionKeyFromSessionId({
      sessionId: raw,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
    });
  }

  const resolvedKey = resolveInternalSessionKey({
    key: raw,
    alias: params.alias,
    mainKey: params.mainKey,
  });
  const displayKey = resolveDisplaySessionKey({
    key: resolvedKey,
    alias: params.alias,
    mainKey: params.mainKey,
  });
  return { ok: true, key: resolvedKey, displayKey, resolvedViaSessionId: false };
}

export function normalizeOptionalKey(value?: string) {
  return normalizeKey(value);
}
