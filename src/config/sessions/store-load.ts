import fs from "node:fs";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import {
  isSessionStoreCacheEnabled,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import {
  normalizeSessionRuntimeModelFields,
  type SessionEntry,
  type SessionRouteSurface,
} from "./types.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
};

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

function normalizeRouteScopeFromSessionKey(sessionKey: string | undefined | null) {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!normalized) {
    return "agent-main" as const;
  }
  if (normalized === "global") {
    return "global" as const;
  }
  if (normalized.endsWith(":heartbeat")) {
    return "heartbeat-isolated" as const;
  }
  if (/:direct:/.test(normalized)) {
    return "peer-scoped-direct" as const;
  }
  if (/^agent:[^:]+:main$/.test(normalized)) {
    return "agent-main" as const;
  }
  if (/^agent:[^:]+:explicit:/.test(normalized)) {
    return "explicit" as const;
  }
  return "explicit" as const;
}

function isMainHeartbeatSessionKey(sessionKey: string | undefined | null): boolean {
  return /^agent:[^:]+:main:heartbeat$/.test(normalizeLowercaseStringOrEmpty(sessionKey));
}

function resolveMainHeartbeatBaseSessionKey(sessionKey: string | undefined | null): string | null {
  if (!isMainHeartbeatSessionKey(sessionKey)) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(sessionKey).replace(/:heartbeat$/u, "");
}

function normalizeLegacyHeartbeatMainEntry(
  sessionKey: string,
  entry: SessionEntry,
): SessionEntry {
  const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!isMainHeartbeatSessionKey(normalizedSessionKey)) {
    return entry;
  }
  const expectedBaseSessionKey = resolveMainHeartbeatBaseSessionKey(normalizedSessionKey);
  const storedBaseSessionKey = normalizeLowercaseStringOrEmpty(entry.heartbeatIsolatedBaseSessionKey);
  const nextHeartbeatBaseSessionKey = storedBaseSessionKey || expectedBaseSessionKey;
  let next = entry;
  if (nextHeartbeatBaseSessionKey && storedBaseSessionKey !== nextHeartbeatBaseSessionKey) {
    next = {
      ...next,
      heartbeatIsolatedBaseSessionKey: nextHeartbeatBaseSessionKey,
    };
  }
  if (next.origin && typeof next.origin === "object") {
    if (next === entry) {
      next = { ...next };
    }
    delete next.origin;
  }
  return next;
}

function normalizeSessionRouteSurface(value: string | null): SessionRouteSurface | null {
  return value === "telegram" ||
    value === "tui" ||
    value === "webchat" ||
    value === "heartbeat" ||
    value === "cron" ||
    value === "hook" ||
    value === "api" ||
    value === "main"
    ? value
    : null;
}

function deriveRouteSurfaceFromEntry(
  sessionKey: string,
  entry: SessionEntry,
): SessionRouteSurface | null {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (normalized.endsWith(":heartbeat")) {
    return "heartbeat";
  }
  const originSurface = normalizeLowercaseStringOrEmpty(
    entry.routeMetadata?.surface ?? entry.origin?.surface ?? entry.origin?.provider,
  );
  const normalizedOriginSurface = normalizeSessionRouteSurface(originSurface);
  if (normalizedOriginSurface) {
    return normalizedOriginSurface;
  }
  const directMatch = normalized.match(/^agent:[^:]+:([^:]+):direct:/);
  const directSurface = normalizeSessionRouteSurface(directMatch?.[1] ?? null);
  if (directSurface) {
    return directSurface;
  }
  const groupedMatch = normalized.match(/^agent:[^:]+:([^:]+):(group|channel):/);
  const groupedSurface = normalizeSessionRouteSurface(groupedMatch?.[1] ?? null);
  if (groupedSurface) {
    return groupedSurface;
  }
  if (/^agent:[^:]+:main$/.test(normalized)) {
    return "main";
  }
  return null;
}

function buildRouteActorFingerprint(entry: SessionEntry): string | null {
  const origin = entry.origin;
  if (!origin || typeof origin !== "object") {
    return null;
  }
  const parts = [
    typeof origin.provider === "string" ? origin.provider : "",
    typeof origin.accountId === "string" ? origin.accountId : "",
    typeof origin.chatType === "string" ? origin.chatType : "",
    typeof origin.from === "string" ? origin.from : "",
    typeof origin.to === "string" ? origin.to : "",
    typeof origin.label === "string" ? origin.label : "",
  ];
  return parts.some((value) => value) ? parts.join("|") : null;
}

function deriveRouteIntegrity(
  sessionKey: string,
  entry: SessionEntry,
  routeMetadata: NonNullable<SessionEntry["routeMetadata"]>,
): NonNullable<SessionEntry["routeIntegrityState"]> {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  const provider = normalizeLowercaseStringOrEmpty(entry.origin?.provider ?? entry.origin?.surface);
  const chatType = normalizeLowercaseStringOrEmpty(entry.origin?.chatType);
  if (/^agent:[^:]+:main$/.test(normalized) && provider === "telegram" && chatType === "direct") {
    return "contradictory";
  }
  if (/^agent:[^:]+:main:heartbeat$/.test(normalized) && provider === "telegram") {
    return "contradictory";
  }
  if (!routeMetadata.surface && !provider && !chatType) {
    return "unknown";
  }
  return "ok";
}

function normalizeSessionEntryRouteMetadata(sessionKey: string, entry: SessionEntry): SessionEntry {
  const normalizedSourceEntry = normalizeLegacyHeartbeatMainEntry(sessionKey, entry);
  const scope = normalizeRouteScopeFromSessionKey(sessionKey);
  const existingRouteMetadata =
    normalizedSourceEntry.routeMetadata && typeof normalizedSourceEntry.routeMetadata === "object"
      ? normalizedSourceEntry.routeMetadata
      : {};
  const routeMetadata = {
    ...existingRouteMetadata,
    resolvedAt:
      typeof existingRouteMetadata.resolvedAt === "number"
        ? existingRouteMetadata.resolvedAt
        : normalizedSourceEntry.updatedAt ?? null,
    sessionKey,
    surface: deriveRouteSurfaceFromEntry(sessionKey, normalizedSourceEntry),
    scope,
    explicit: scope === "explicit",
    actorFingerprint: buildRouteActorFingerprint(normalizedSourceEntry),
    heartbeatIsolatedBaseSessionKey:
      typeof normalizedSourceEntry.heartbeatIsolatedBaseSessionKey === "string"
        ? normalizedSourceEntry.heartbeatIsolatedBaseSessionKey
        : null,
    provenance: {
      provider:
        typeof normalizedSourceEntry.origin?.provider === "string"
          ? normalizedSourceEntry.origin.provider
          : null,
      surface:
        typeof normalizedSourceEntry.origin?.surface === "string"
          ? normalizedSourceEntry.origin.surface
          : null,
      from:
        typeof normalizedSourceEntry.origin?.from === "string"
          ? normalizedSourceEntry.origin.from
          : null,
      to:
        typeof normalizedSourceEntry.origin?.to === "string" ? normalizedSourceEntry.origin.to : null,
      chatType:
        typeof normalizedSourceEntry.origin?.chatType === "string"
          ? normalizedSourceEntry.origin.chatType
          : null,
      label:
        typeof normalizedSourceEntry.origin?.label === "string"
          ? normalizedSourceEntry.origin.label
          : null,
      accountId:
        typeof normalizedSourceEntry.origin?.accountId === "string"
          ? normalizedSourceEntry.origin.accountId
          : null,
      threadId: normalizedSourceEntry.origin?.threadId ?? null,
    },
  };
  const integrity = deriveRouteIntegrity(sessionKey, normalizedSourceEntry, routeMetadata);
  const normalizedEntry: SessionEntry = {
    ...normalizedSourceEntry,
    routeMetadata: {
      ...routeMetadata,
      integrity,
    },
    routeIntegrityState: integrity,
  };
  return JSON.stringify(entry) === JSON.stringify(normalizedEntry) ? entry : normalizedEntry;
}

export function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryRouteMetadata(
      key,
      normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry)),
    );
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const currentFileStat = getFileStatSnapshot(storePath);
    const cached = readSessionStoreCache({
      storePath,
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
    });
    if (cached) {
      return cached;
    }
  }

  // Retry a few times on Windows because readers can briefly observe empty or
  // transiently invalid content while another process is swapping the file.
  let store: Record<string, SessionEntry> = {};
  let fileStat = getFileStatSnapshot(storePath);
  let mtimeMs = fileStat?.mtimeMs;
  let serializedFromDisk: string | undefined;
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0 && attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      const parsed = JSON.parse(raw);
      if (isSessionStoreRecord(parsed)) {
        store = parsed;
        serializedFromDisk = raw;
      }
      fileStat = getFileStatSnapshot(storePath) ?? fileStat;
      mtimeMs = fileStat?.mtimeMs;
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }

  if (serializedFromDisk !== undefined) {
    setSerializedSessionStore(storePath, serializedFromDisk);
  } else {
    setSerializedSessionStore(storePath, undefined);
  }

  applySessionStoreMigrations(store);
  normalizeSessionStore(store);

  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    writeSessionStoreCache({
      storePath,
      store,
      mtimeMs,
      sizeBytes: fileStat?.sizeBytes,
      serialized: serializedFromDisk,
    });
  }

  return structuredClone(store);
}
