import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import type { SessionScope } from "../config/sessions/types.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import type { SessionEntryLike } from "./state-migrations.fs.js";
import {
  isLegacyDefaultMainAliasKey,
  resolveCanonicalAgentSessionOwner,
  type PreparedLegacySessionSurfaces,
} from "./state-migrations.session-surfaces.js";

type SessionKeyCanonicalizationOptions = {
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces["surfaces"];
};

export function canonicalizeLegacySessionKeyForAgent(
  params: SessionKeyCanonicalizationOptions & {
    key: string;
    skipCrossAgentRemap?: boolean;
    preserveCanonicalAgentOwner?: boolean;
  },
): string {
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  const legacyDefaultMainAlias = isLegacyDefaultMainAliasKey(rawLower, params.mainKey);
  const configuredAgentId = normalizeAgentId(params.agentId);
  const canonicalRowOwner = resolveCanonicalAgentSessionOwner(raw);
  // Shared stores may contain rows for several agents. Canonicalize a valid
  // wrapper within its declared owner so another agent pass cannot adopt it.
  // The default-agent main alias remains an orphan when a different single
  // owner is authoritative for this store.
  const candidateOwner = params.preserveCanonicalAgentOwner ? canonicalRowOwner : undefined;
  const parsedOwner =
    candidateOwner === DEFAULT_AGENT_ID &&
    configuredAgentId !== DEFAULT_AGENT_ID &&
    legacyDefaultMainAlias
      ? undefined
      : candidateOwner;
  const agentId = parsedOwner ?? configuredAgentId;
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }
  // Plugin-routed stores can contain either a core orphan or an opaque explicit
  // key with this shape. Without row provenance, never merge the two.
  if (params.preserveForeignMainAliases && legacyDefaultMainAlias) {
    return params.key;
  }
  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
    agentId,
    sessionKey: normalized,
  });
  // Global scope has one owner, so recognized main aliases are never ambiguous.
  if (params.scope === "global" && canonicalMain === "global") {
    return canonicalMain;
  }
  // Unscoped and legacy default-main keys in a potentially shared store have no durable owner.
  // Keep it untouched instead of assigning another agent's history by iteration order.
  if (params.preserveAmbiguousKeys && (!canonicalRowOwner || legacyDefaultMainAlias)) {
    return params.key;
  }

  // When shared-store guard is active, do not remap keys that belong to a
  // different agent — they are legitimate records for that agent, not orphans.
  // Without this check, canonicalizeMainSessionAlias (which now recognises
  // legacy agent:main:* aliases) would rewrite them before the
  // skipCrossAgentRemap guard below has a chance to block it.
  if (params.skipCrossAgentRemap) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
      return normalized;
    }
    if (
      agentId !== DEFAULT_AGENT_ID &&
      (rawLower === DEFAULT_MAIN_KEY || rawLower === params.mainKey)
    ) {
      return rawLower;
    }
  }

  if (canonicalMain !== normalized) {
    return normalizeLowercaseStringOrEmpty(canonicalMain);
  }

  // Handle cross-agent orphaned main-session keys: "agent:main:main" or
  // "agent:main:<mainKey>" in a store belonging to a different agent (e.g.
  // "ops"). Only remap provable orphan aliases — other agent:main:* keys
  // (hooks, subagents, cron, per-sender) may be intentional cross-agent
  // references and must not be touched (#29683).
  const defaultPrefix = `agent:${DEFAULT_AGENT_ID}:`;
  if (
    rawLower.startsWith(defaultPrefix) &&
    agentId !== DEFAULT_AGENT_ID &&
    !params.skipCrossAgentRemap
  ) {
    const rest = rawLower.slice(defaultPrefix.length);
    const isOrphanAlias = rest === DEFAULT_MAIN_KEY || rest === params.mainKey;
    if (isOrphanAlias) {
      const remapped = `agent:${agentId}:${rest}`;
      const canonicalized = canonicalizeMainSessionAlias({
        cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
        agentId,
        sessionKey: remapped,
      });
      return normalizeLowercaseStringOrEmpty(canonicalized);
    }
  }

  // A malformed agent-shaped key has no authoritative row owner. Once shared-store
  // preservation is ruled out, treat it as opaque input owned by the configured agent.
  if (rawLower.startsWith("agent:") && canonicalRowOwner) {
    return normalized;
  }
  if (rawLower.startsWith("subagent:")) {
    const rest = raw.slice("subagent:".length);
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${rest}`);
  }
  // Channel-owned legacy shapes must win before the generic group/channel
  // fallback so plugin-specific legacy group keys can canonicalize to their
  // owning channel instead of the generic `...:unknown:group:...` bucket.
  for (const surface of params.legacySessionSurfaces ?? []) {
    const canonicalized = surface.canonicalizeLegacySessionKey?.({
      key: raw,
      agentId,
    });
    const normalizedCanonicalized = normalizeSessionKeyPreservingOpaquePeerIds(canonicalized);
    if (normalizedCanonicalized) {
      return normalizedCanonicalized;
    }
  }
  if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:unknown:${raw}`);
  }
  if (raw.includes(":group:") || raw.includes(":channel:")) {
    return `agent:${agentId}:${normalized}`;
  }
  return normalizeSessionKeyPreservingOpaquePeerIds(`agent:${agentId}:${raw}`);
}

export function canonicalizeSessionStore({
  store,
  ...options
}: SessionKeyCanonicalizationOptions & {
  store: Record<string, SessionEntryLike>;
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  // SAFETY: The null-prototype dictionary starts empty; every value assigned below is a SessionEntryLike.
  const canonical = Object.create(null) as Record<string, SessionEntryLike>;
  const meta = new Map<string, { isCanonical: boolean; updatedAt: number }>();
  const legacyKeys: string[] = [];

  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const canonicalKey = canonicalizeLegacySessionKeyForAgent({
      ...options,
      key,
      skipCrossAgentRemap: options.preserveAmbiguousKeys,
      preserveCanonicalAgentOwner: true,
    });
    const isCanonical = canonicalKey === key;
    if (!isCanonical) {
      legacyKeys.push(key);
    }
    const existingMeta = meta.get(canonicalKey);
    const incomingUpdated = asFiniteNumber(entry.updatedAt) ?? 0;
    if (
      !existingMeta ||
      incomingUpdated > existingMeta.updatedAt ||
      (incomingUpdated === existingMeta.updatedAt && isCanonical && !existingMeta.isCanonical)
    ) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
    }
  }

  return { store: canonical, legacyKeys };
}

export function isAmbiguousSharedStoreKey(
  key: string,
  mainKey: string,
  scope?: SessionScope,
): boolean {
  const raw = key.trim();
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (!raw || lower === "global" || lower === "unknown") {
    return false;
  }
  if (
    scope === "global" &&
    canonicalizeMainSessionAlias({
      cfg: { session: { scope, mainKey } },
      agentId: DEFAULT_AGENT_ID,
      sessionKey: lower,
    }) === "global"
  ) {
    return false;
  }
  return !resolveCanonicalAgentSessionOwner(raw) || isLegacyDefaultMainAliasKey(lower, mainKey);
}

export function sessionStoreMayNeedCanonicalization(params: {
  store: Record<string, SessionEntryLike>;
  storeAgentIds: Iterable<string>;
  mainKey: string;
  scope?: SessionScope;
  preserveForeignMainAliases?: boolean;
}): boolean {
  const storeAgentIds = new Set([...params.storeAgentIds].map((id) => normalizeAgentId(id)));
  const hasNonMainAgent = [...storeAgentIds].some((id) => id !== DEFAULT_AGENT_ID);
  for (const key of Object.keys(params.store)) {
    const rawKey = key.trim();
    if (rawKey !== key) {
      return true;
    }
    if (!rawKey) {
      continue;
    }
    const lowerKey = normalizeLowercaseStringOrEmpty(rawKey);
    if (lowerKey !== rawKey) {
      return true;
    }
    if (lowerKey === "global" || lowerKey === "unknown") {
      continue;
    }
    if (
      params.preserveForeignMainAliases &&
      isLegacyDefaultMainAliasKey(lowerKey, params.mainKey)
    ) {
      return true;
    }
    if (lowerKey === DEFAULT_MAIN_KEY || lowerKey === params.mainKey) {
      return true;
    }
    if (!lowerKey.startsWith("agent:")) {
      return true;
    }
    const rowOwner = resolveCanonicalAgentSessionOwner(rawKey);
    if (!rowOwner) {
      return true;
    }
    const agentMainAlias = `agent:${rowOwner}:${DEFAULT_MAIN_KEY}`;
    const agentMainKey = `agent:${rowOwner}:${params.mainKey}`;
    if (
      lowerKey === agentMainAlias &&
      (params.mainKey !== DEFAULT_MAIN_KEY || params.scope === "global")
    ) {
      return true;
    }
    if (lowerKey === agentMainKey && params.scope === "global") {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${DEFAULT_MAIN_KEY}` &&
      (params.mainKey !== DEFAULT_MAIN_KEY || hasNonMainAgent || params.scope === "global")
    ) {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${params.mainKey}` &&
      hasNonMainAgent &&
      !storeAgentIds.has(DEFAULT_AGENT_ID)
    ) {
      return true;
    }
  }
  return false;
}

export function listLegacySessionKeys({
  store,
  ...options
}: SessionKeyCanonicalizationOptions & {
  store: Record<string, SessionEntryLike>;
}): string[] {
  return Object.keys(store).filter(
    (key) =>
      canonicalizeLegacySessionKeyForAgent({
        ...options,
        key,
        skipCrossAgentRemap: options.preserveAmbiguousKeys,
        preserveCanonicalAgentOwner: options.preserveAmbiguousKeys,
      }) !== key,
  );
}
