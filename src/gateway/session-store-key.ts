import { ok, type Result } from "@openclaw/normalization-core/result";
// Session-store key canonicalization across default agents, main aliases, and legacy keys.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
import {
  resolveSessionStoreCompatibilityAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../config/legacy.default-agent-owner.js";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { isPerAgentSessionStoreConfig } from "../config/sessions/session-store-config.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  DEFAULT_AGENT_ID,
  isIncognitoSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { getOrCreateWeakOwnerMap } from "../shared/weak-owner-map.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "./session-request-agent.js";

export type SessionRoutingTarget = Omit<Parameters<typeof resolveSessionStoreIdentity>[0], "cfg">;

export function readSessionRoutingFacts(
  cfg: OpenClawConfig,
  targets?: readonly SessionRoutingTarget[],
) {
  const agents = listAgentIds(cfg);
  const identities = targets?.map((target) => resolveSessionStoreIdentity({ ...target, cfg }));
  // Retired-agent discovery searches the roster; configured targets retain only their own route.
  const scoped = identities?.every(({ agentId }) => agents.includes(agentId));
  return {
    agents: scoped ? undefined : agents,
    identities,
    storeOwner:
      scoped && isPerAgentSessionStoreConfig(cfg.session?.store)
        ? undefined
        : resolveSessionStoreCompatibilityAgentId(cfg),
    compatibilityOwner: targets ? undefined : tryResolveLegacyCompatibilityAgentId(cfg),
    systemOwner: targets ? undefined : tryResolveAmbientOwnerAgentId(cfg),
    store: cfg.session?.store,
    mainKey: cfg.session?.mainKey,
    scope: cfg.session?.scope,
  };
}

/** Canonicalize an opaque session key into the agent-scoped store namespace. */
export function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(key);
  return normalized === "global" || normalized === "unknown" || normalized.startsWith("agent:")
    ? normalized
    : `agent:${normalizeAgentId(agentId)}:${normalized}`;
}

// Logical unscoped keys must honor the durable fixed-store owner. The physical-store
// compatibility fallback is intentionally not used here because it can name a retired agent.
function resolveLogicalSessionStoreAgentId(cfg: OpenClawConfig, sessionKey: string): string {
  const agentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
  if (agentId) {
    return agentId;
  }
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);
  throw new AgentSelectionRequiredError(listAgentIds(cfg), {
    surface: `session key "${sessionKey}"`,
    hint:
      persistedOwner.kind === "retired"
        ? `Its recorded owner "${persistedOwner.agentId}" is no longer configured. Select a configured agent explicitly.`
        : "Use an agent-prefixed session key or select an agent explicitly.",
  });
}

function resolveParsedSessionStoreKey(
  cfg: OpenClawConfig,
  normalizedKey: string,
  parsed: ParsedAgentSessionKey,
  storeAgentId?: string,
): { agentId: string; sessionKey: string } {
  const parsedAgentId = normalizeAgentId(parsed.agentId);
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  // Only legacy main aliases need the configured roster to resolve ownership.
  if (
    parsedAgentId !== DEFAULT_AGENT_ID ||
    (rest !== "main" && rest !== normalizeMainKey(cfg.session?.mainKey)) ||
    listAgentIds(cfg).includes(DEFAULT_AGENT_ID)
  ) {
    return {
      agentId: parsedAgentId,
      sessionKey: normalizedKey,
    };
  }
  const agentId = storeAgentId
    ? normalizeAgentId(storeAgentId)
    : resolveLogicalSessionStoreAgentId(cfg, "main");
  return { agentId, sessionKey: `agent:${agentId}:${rest}` };
}

function canonicalizeParsedSessionStoreKey(
  cfg: OpenClawConfig,
  normalizedKey: string,
  parsed: ParsedAgentSessionKey,
  storeAgentId?: string,
  preserveQualifiedAddress = false,
): string {
  const resolved = resolveParsedSessionStoreKey(cfg, normalizedKey, parsed, storeAgentId);
  if (preserveQualifiedAddress && resolved.agentId === normalizeAgentId(parsed.agentId)) {
    return resolved.sessionKey;
  }
  return canonicalizeMainSessionAlias({
    cfg,
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
  });
}

/** Resolve any incoming session key into the canonical key used in persisted session stores. */
export function resolveSessionStoreKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storeAgentId?: string;
}): string {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  const normalizedKey = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  const parsed = parseAgentSessionKeyParts(normalizedKey);
  if (parsed) {
    return canonicalizeParsedSessionStoreKey(
      params.cfg,
      normalizedKey,
      parsed,
      params.storeAgentId,
    );
  }

  const rawLower = raw.toLowerCase();
  if (!raw || rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const storeAgentId = params.storeAgentId ? normalizeAgentId(params.storeAgentId) : undefined;
  if (rawLower === "main" || rawLower === rawMainKey) {
    if (params.cfg.session?.scope === "global") {
      return "global";
    }
    return resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId: storeAgentId ?? resolveLogicalSessionStoreAgentId(params.cfg, raw),
    });
  }
  const agentId = storeAgentId ?? resolveLogicalSessionStoreAgentId(params.cfg, raw);
  return canonicalizeSessionKeyForAgent(agentId, raw);
}

export function resolveRequestedSessionStoreTarget(
  cfg: OpenClawConfig,
  sessionKey: string,
  explicitAgentId?: string,
  admission: "read" | "write" = "write",
): Result<{ sessionKey: string; agentId: string }, ErrorShape> {
  const requested = resolveRequestedSessionAgentId(cfg, sessionKey, explicitAgentId, admission);
  if (!requested.ok) {
    return requested;
  }
  return ok({
    sessionKey: resolveSessionStoreKey({ cfg, sessionKey, storeAgentId: requested.agentId }),
    agentId: requested.agentId,
  });
}

/** Resolve ownership before a prepared agent's main alias collapses to global. */
export function resolveSessionStoreAgentId(
  cfg: OpenClawConfig,
  canonicalKey: string,
  explicitAgentId?: string,
): string {
  const normalizedKey = normalizeSessionKeyPreservingOpaquePeerIds(canonicalKey);
  const parsed = parseAgentSessionKeyParts(normalizedKey);
  if (explicitAgentId) {
    const sessionKey = parsed
      ? resolveParsedSessionStoreKey(cfg, normalizedKey, parsed, explicitAgentId).sessionKey
      : canonicalKey;
    return resolveSessionAgentId({ config: cfg, sessionKey, agentId: explicitAgentId });
  }
  return parsed
    ? normalizeAgentId(parsed.agentId)
    : resolveLogicalSessionStoreAgentId(cfg, canonicalKey);
}

type SessionStoreIdentityParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  preserveQualifiedAddress?: boolean;
};
type SessionStoreIdentity = Readonly<{ agentId: string; canonicalKey: string }>;
const sessionStoreIdentities = new WeakMap<object, Map<string, SessionStoreIdentity>>();

/** Share deterministic routing only; callers still revalidate live sharing authority. */
export function resolveSessionStoreIdentity(
  params: SessionStoreIdentityParams,
): SessionStoreIdentity {
  const current = runtimeConfigPublication.current;
  const generation =
    current?.config === params.cfg
      ? current.revision
      : isDeeplyFrozenPlainData(params.cfg)
        ? params.cfg
        : undefined;
  if (!generation) {
    return deriveSessionStoreIdentity(params);
  }
  const identities = getOrCreateWeakOwnerMap(sessionStoreIdentities, generation);
  const key = JSON.stringify([
    params.sessionKey,
    params.agentId,
    params.preserveQualifiedAddress === true,
  ]);
  let identity = identities.get(key);
  if (!identity) {
    identity = Object.freeze(deriveSessionStoreIdentity(params));
    identities.set(key, identity);
    // Bound long-lived publications; retired generations are weakly held.
    if (identities.size > 16_384) {
      pruneMapToMaxSize(identities, 16_384);
    }
  }
  return identity;
}

/** Preserve raw alias ownership and validate the canonical fixed-store boundary together. */
function deriveSessionStoreIdentity(params: SessionStoreIdentityParams): SessionStoreIdentity {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  const requestedAgentId = normalizeOptionalString(params.agentId);
  const normalizedKey = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  const parsed = parseAgentSessionKeyParts(normalizedKey);
  if (params.preserveQualifiedAddress && parsed) {
    const canonicalKey = normalizedKey;
    return {
      agentId: resolveSessionAgentId({
        config: params.cfg,
        sessionKey: canonicalKey,
        agentId: requestedAgentId,
      }),
      canonicalKey,
    };
  }
  const sessionKey = parsed
    ? resolveParsedSessionStoreKey(params.cfg, normalizedKey, parsed, requestedAgentId).sessionKey
    : raw;
  const agentId = resolveSessionStoreAgentId(params.cfg, sessionKey, requestedAgentId);
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey,
    storeAgentId: agentId,
  });
  // Global removes the prefix, but may still belong to a different persisted fixed-store owner.
  resolveSessionStoreAgentId(params.cfg, canonicalKey, agentId);
  return { agentId, canonicalKey };
}

/** Resolve a session key for lookup inside a specific agent's store. */
export function resolveStoredSessionKeyForAgentStore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  preserveQualifiedAddress?: boolean;
}): string {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  const lowered = raw.toLowerCase();
  if (!raw || lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  const normalizedKey = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  const parsed = parseAgentSessionKeyParts(normalizedKey);
  if (parsed) {
    return canonicalizeParsedSessionStoreKey(
      params.cfg,
      normalizedKey,
      parsed,
      params.agentId,
      params.preserveQualifiedAddress,
    );
  }
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(params.cfg, raw);
  if (
    persistedOwner.kind === "configured" &&
    persistedOwner.agentId === normalizeAgentId(params.agentId) &&
    lowered !== "main" &&
    lowered !== normalizeMainKey(params.cfg.session?.mainKey)
  ) {
    return raw;
  }
  const key = canonicalizeSessionKeyForAgent(params.agentId, raw);
  return resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
    storeAgentId: params.agentId,
  });
}

/** Existing stored lineage wins; only absence permits the shipped main-alias lookup. */
export function selectStoredSessionLineage<T>(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  read: (agentId: string, sessionKey: string) => T | undefined;
  readAlias?: (agentId: string, sessionKey: string) => T | undefined;
}): { agentId: string; key: string; value: T | undefined } {
  const agentId = normalizeAgentId(
    parseAgentSessionKey(params.sessionKey)?.agentId ?? params.agentId,
  );
  const target = { cfg: params.cfg, agentId, sessionKey: params.sessionKey };
  const storedKey = resolveStoredSessionKeyForAgentStore({
    ...target,
    preserveQualifiedAddress: true,
  });
  const value = params.read(agentId, storedKey);
  if (value !== undefined || isIncognitoSessionKey(storedKey)) {
    return { agentId, key: storedKey, value };
  }
  const key = resolveStoredSessionKeyForAgentStore(target);
  return {
    agentId,
    key,
    value:
      key === storedKey && !params.readAlias
        ? undefined
        : (params.readAlias ?? params.read)(agentId, key),
  };
}

/** Resolve the owner agent for a stored session key, returning null for global/unknown keys. */
export function resolveStoredSessionOwnerAgentId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string | null {
  const canonicalKey = resolveStoredSessionKeyForAgentStore(params);
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return null;
  }
  return resolveSessionStoreAgentId(params.cfg, canonicalKey);
}
