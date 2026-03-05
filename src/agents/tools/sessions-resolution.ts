import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { logWarn } from "../../logger.js";
import { isAcpSessionKey, normalizeMainKey } from "../../routing/session-key.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";

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

const SESSIONS_LIST_RETRY_BACKOFF_MS = [40, 120] as const;

type SpawnedSessionListResult = {
  keys: Set<string>;
  verified: boolean;
};

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return String(err);
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logSpawnVerificationFailOpen(params: {
  reasonTag: "sessions_list_throw" | "sessions_list_unexpected_shape";
  requesterSessionKey: string;
  limit: number;
  attempt: number;
  detail: string;
}) {
  logWarn(
    `subagent-spawn-verify: fail-open reason=${params.reasonTag} requester=${params.requesterSessionKey} limit=${params.limit} attempt=${params.attempt} detail=${params.detail}`,
  );
}

async function listSpawnedSessionKeysForVerification(params: {
  requesterSessionKey: string;
  limit: number;
}): Promise<SpawnedSessionListResult> {
  const attempts = SESSIONS_LIST_RETRY_BACKOFF_MS.length + 1;
  for (let index = 0; index < attempts; index += 1) {
    const attempt = index + 1;
    try {
      const list = await callGateway<{ sessions?: unknown }>({
        method: "sessions.list",
        params: {
          includeGlobal: false,
          includeUnknown: false,
          limit: params.limit,
          spawnedBy: params.requesterSessionKey,
        },
      });

      if (!Array.isArray(list?.sessions)) {
        logSpawnVerificationFailOpen({
          reasonTag: "sessions_list_unexpected_shape",
          requesterSessionKey: params.requesterSessionKey,
          limit: params.limit,
          attempt,
          detail: `sessionsType=${typeof list?.sessions}`,
        });
        return { keys: new Set(), verified: false };
      }

      const keys = list.sessions
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return "";
          }
          const key = (entry as { key?: unknown }).key;
          return typeof key === "string" ? key : "";
        })
        .map((value) => value.trim())
        .filter(Boolean);
      return { keys: new Set(keys), verified: true };
    } catch (err) {
      if (index < SESSIONS_LIST_RETRY_BACKOFF_MS.length) {
        await delayMs(SESSIONS_LIST_RETRY_BACKOFF_MS[index]);
        continue;
      }
      logSpawnVerificationFailOpen({
        reasonTag: "sessions_list_throw",
        requesterSessionKey: params.requesterSessionKey,
        limit: params.limit,
        attempt,
        detail: summarizeError(err),
      });
      return { keys: new Set(), verified: false };
    }
  }
  return { keys: new Set(), verified: false };
}

export async function listSpawnedSessionKeys(params: {
  requesterSessionKey: string;
  limit?: number;
}): Promise<Set<string>> {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : 500;
  const result = await listSpawnedSessionKeysForVerification({
    requesterSessionKey: params.requesterSessionKey,
    limit,
  });
  return result.keys;
}

export async function isRequesterSpawnedSessionVisible(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  limit?: number;
}): Promise<boolean> {
  if (params.requesterSessionKey === params.targetSessionKey) {
    return true;
  }
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : 500;
  const result = await listSpawnedSessionKeysForVerification({
    requesterSessionKey: params.requesterSessionKey,
    limit,
  });
  if (!result.verified) {
    return true;
  }
  return result.keys.has(params.targetSessionKey);
}

export function shouldVerifyRequesterSpawnedSessionVisibility(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  restrictToSpawned: boolean;
  resolvedViaSessionId: boolean;
}): boolean {
  return (
    params.restrictToSpawned &&
    !params.resolvedViaSessionId &&
    params.requesterSessionKey !== params.targetSessionKey
  );
}

export async function isResolvedSessionVisibleToRequester(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  restrictToSpawned: boolean;
  resolvedViaSessionId: boolean;
  limit?: number;
}): Promise<boolean> {
  if (
    !shouldVerifyRequesterSpawnedSessionVisibility({
      requesterSessionKey: params.requesterSessionKey,
      targetSessionKey: params.targetSessionKey,
      restrictToSpawned: params.restrictToSpawned,
      resolvedViaSessionId: params.resolvedViaSessionId,
    })
  ) {
    return true;
  }
  return await isRequesterSpawnedSessionVisible({
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: params.targetSessionKey,
    limit: params.limit,
  });
}

export { looksLikeSessionId };

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

export type VisibleSessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
    }
  | {
      ok: false;
      status: "forbidden";
      error: string;
      displayKey: string;
    };

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

export async function resolveVisibleSessionReference(params: {
  resolvedSession: Extract<SessionReferenceResolution, { ok: true }>;
  requesterSessionKey: string;
  restrictToSpawned: boolean;
  visibilitySessionKey: string;
}): Promise<VisibleSessionReferenceResolution> {
  const resolvedKey = params.resolvedSession.key;
  const displayKey = params.resolvedSession.displayKey;
  const visible = await isResolvedSessionVisibleToRequester({
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: resolvedKey,
    restrictToSpawned: params.restrictToSpawned,
    resolvedViaSessionId: params.resolvedSession.resolvedViaSessionId,
  });
  if (!visible) {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from this sandboxed agent session: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  return { ok: true, key: resolvedKey, displayKey };
}

export function normalizeOptionalKey(value?: string) {
  return normalizeKey(value);
}
