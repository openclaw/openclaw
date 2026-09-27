/**
 * Subagent capability resolution.
 * Combines session-key shape, stored envelopes, spawn depth, and inherited tool
 * policy to decide role, control scope, and subagent permissions.
 */
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
  isSubagentSpawnDepthAllowed,
} from "../../../config/agent-limits.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "../../inherited-tool-deny.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import {
  asSessionCapabilityLookup,
  createSubagentSessionStore,
  isSessionCapabilityLookup,
  type PreparedSessionCapabilityEntry,
  type SessionCapabilityEntry,
  type SessionCapabilityStore,
} from "./subagent-session-store.js";

export type {
  PreparedSessionCapabilityEntry,
  SessionCapabilityStore,
} from "./subagent-session-store.js";

/** Resolved role for a main session, orchestrating subagent, or leaf subagent. */
export type SubagentSessionRole = "main" | "orchestrator" | "leaf";
const SUBAGENT_SESSION_ROLES: readonly SubagentSessionRole[] = [
  "main",
  "orchestrator",
  "leaf",
] as const;

type SubagentControlScope = "children" | "none";
const SUBAGENT_CONTROL_SCOPES: readonly SubagentControlScope[] = ["children", "none"] as const;

type PersistedSubagentToolPolicyEnvelope = {
  sessionKey: string;
  spawnedBy: string;
  completionOwnerSessionKey?: string;
  inheritedToolAllow: string[];
  inheritedToolDeny: string[];
};

function normalizeSubagentRole(value: unknown): SubagentSessionRole | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}

function normalizeSubagentControlScope(value: unknown): SubagentControlScope | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}

function shouldInspectStoredSubagentEnvelope(sessionKey: string): boolean {
  // ACP session keys can represent resumed subagents only when their persisted
  // envelope carries subagent metadata or points back to a subagent parent.
  return isSubagentSessionKey(sessionKey) || isAcpSessionKey(sessionKey);
}

function isDashboardSessionKey(sessionKey: string): boolean {
  return parseAgentSessionKey(sessionKey)?.rest.startsWith("dashboard:") === true;
}

function canInspectStoredSubagentEnvelope(
  sessionKey: string,
  store?: SessionCapabilityStore,
): boolean {
  return (
    shouldInspectStoredSubagentEnvelope(sessionKey) ||
    (Boolean(store) && isDashboardSessionKey(sessionKey))
  );
}

function isSameAgentSessionStore(leftSessionKey: string, rightSessionKey: string): boolean {
  const leftAgentId = normalizeOptionalLowercaseString(
    parseAgentSessionKey(leftSessionKey)?.agentId,
  );
  const rightAgentId = normalizeOptionalLowercaseString(
    parseAgentSessionKey(rightSessionKey)?.agentId,
  );
  return Boolean(leftAgentId) && leftAgentId === rightAgentId;
}

function resolveSessionCapabilityEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: SessionCapabilityStore;
}): SessionCapabilityEntry | undefined {
  if (params.store) {
    const store = asSessionCapabilityLookup(params.store);
    return store.get(params.sessionKey) ?? store.getById(params.sessionKey);
  }
  if (!params.cfg) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed?.agentId) {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: parsed.agentId,
  });
  const store = createSubagentSessionStore(storePath, parsed.agentId);
  return store.get(params.sessionKey) ?? store.getById(params.sessionKey);
}

/** Resolve the session-store subset used for subagent capability lookup. */
export function resolveSubagentCapabilityStore(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    agentId?: string;
    preparedSessionEntry?: PreparedSessionCapabilityEntry;
  },
): SessionCapabilityStore | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return opts?.store;
  }
  if (opts?.store) {
    return opts.store;
  }
  // Dashboard key shape permits only a store lookup. Callers still require a
  // persisted spawn envelope before granting subagent authority.
  if (
    !opts?.cfg ||
    (!shouldInspectStoredSubagentEnvelope(normalizedSessionKey) &&
      !isDashboardSessionKey(normalizedSessionKey))
  ) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed?.agentId) {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(opts.cfg.session?.store, {
    agentId: parsed.agentId,
  });
  return createSubagentSessionStore(
    storePath,
    parsed.agentId,
    opts.preparedSessionEntry?.sessionKey === normalizedSessionKey
      ? opts.preparedSessionEntry
      : undefined,
  );
}

/** Resolve depth-derived role, scope, and spawn/control booleans. */
export function resolveSubagentCapabilities(params: { depth: number; maxSpawnDepth?: number }) {
  const depth = resolveNonNegativeIntegerOption(params.depth, 0);
  const maxSpawnDepth = resolveIntegerOption(
    params.maxSpawnDepth,
    DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
    { min: 1 },
  );
  const role: SubagentSessionRole =
    depth <= 0
      ? "main"
      : isSubagentSpawnDepthAllowed(depth, maxSpawnDepth)
        ? "orchestrator"
        : "leaf";
  const controlScope: SubagentControlScope = role === "leaf" ? "none" : "children";
  return {
    depth,
    role,
    controlScope,
    canSpawn: role === "main" || role === "orchestrator",
    canControlChildren: controlScope === "children",
  };
}

function isStoredSubagentEnvelopeSession(
  params: {
    sessionKey: string;
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    entry?: SessionCapabilityEntry;
  },
  visited = new Set<string>(),
): boolean {
  const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
  if (!normalizedSessionKey || visited.has(normalizedSessionKey)) {
    return false;
  }
  visited.add(normalizedSessionKey);

  if (isSubagentSessionKey(normalizedSessionKey)) {
    return true;
  }
  const dashboardSession = isDashboardSessionKey(normalizedSessionKey);
  if (!isAcpSessionKey(normalizedSessionKey) && !dashboardSession) {
    return false;
  }

  const entry =
    params.entry ??
    resolveSessionCapabilityEntry({
      sessionKey: normalizedSessionKey,
      cfg: params.cfg,
      store: params.store,
    });
  if (dashboardSession) {
    return (
      typeof entry?.spawnDepth === "number" &&
      Number.isInteger(entry.spawnDepth) &&
      entry.spawnDepth >= 1 &&
      Boolean(normalizeOptionalString(entry.spawnedBy))
    );
  }
  if (
    normalizeSubagentRole(entry?.subagentRole) ||
    normalizeSubagentControlScope(entry?.subagentControlScope)
  ) {
    return true;
  }

  const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
  if (!spawnedBy) {
    return false;
  }
  const parentStore =
    isSameAgentSessionStore(normalizedSessionKey, spawnedBy) ||
    (isSessionCapabilityLookup(params.store) && params.store.authoritative)
      ? params.store
      : undefined;
  // Follow parent links across stored ACP envelopes to recover subagent identity
  // for resumed sessions, while `visited` prevents malformed cycles.
  return isStoredSubagentEnvelopeSession(
    {
      sessionKey: spawnedBy,
      cfg: params.cfg,
      store: parentStore,
    },
    visited,
  );
}

/** Return true when a session key or persisted ACP envelope represents a subagent. */
export function isSubagentEnvelopeSession(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    entry?: SessionCapabilityEntry;
  },
): boolean {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return false;
  }
  if (isSubagentSessionKey(normalizedSessionKey)) {
    return true;
  }
  if (!isAcpSessionKey(normalizedSessionKey) && !isDashboardSessionKey(normalizedSessionKey)) {
    return false;
  }
  if (isDashboardSessionKey(normalizedSessionKey) && !opts?.entry && !opts?.store) {
    return false;
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  return isStoredSubagentEnvelopeSession({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
    entry: opts?.entry,
  });
}

/**
 * Resolve a persisted child envelope that is strong enough to carry authority.
 * Session-key shape alone is useful for fail-closed subagent restrictions, but
 * never sufficient to bypass requester-scoped policy re-resolution.
 */
export function resolvePersistedSubagentToolPolicyEnvelope(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    agentId?: string;
  },
): PersistedSubagentToolPolicyEnvelope | undefined {
  const stored = resolveStoredSubagentToolPolicy(sessionKey, opts);
  if (!stored) {
    return undefined;
  }
  const { sessionKey: normalizedSessionKey, store, entry } = stored;
  const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
  const hasSpawnDepth =
    typeof entry?.spawnDepth === "number" &&
    Number.isInteger(entry.spawnDepth) &&
    entry.spawnDepth >= 1;
  const role = normalizeSubagentRole(entry?.subagentRole);
  const controlScope = normalizeSubagentControlScope(entry?.subagentControlScope);
  if (
    !entry ||
    !spawnedBy ||
    entry.inheritedToolPolicyVersion !== 1 ||
    !isSubagentEnvelopeSession(normalizedSessionKey, { ...opts, store, entry }) ||
    (!hasSpawnDepth && role === undefined && controlScope === undefined)
  ) {
    return undefined;
  }
  const completionOwnerSessionKey = normalizeOptionalString(entry.completionOwnerSessionKey);
  return {
    sessionKey: normalizedSessionKey,
    spawnedBy,
    ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}),
    inheritedToolAllow: normalizeInheritedToolAllowlist(entry.inheritedToolAllow),
    inheritedToolDeny: normalizeInheritedToolDenylist(entry.inheritedToolDeny),
  };
}

/**
 * Resolve the effective subagent role/scope, combining stored envelope metadata
 * with depth-derived fallback behavior.
 */
export function resolveStoredSubagentCapabilities(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    agentId?: string;
  },
) {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  const maxSpawnDepth =
    opts?.cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (!normalizedSessionKey) {
    return resolveSubagentCapabilities({ depth: 0, maxSpawnDepth });
  }
  if (!shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
      cfg: opts?.cfg,
      store: opts?.store,
      agentId: opts?.agentId,
    });
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
  });
  const depthStore =
    opts?.cfg && !isSessionCapabilityLookup(store) && typeof entry?.spawnDepth !== "number"
      ? undefined
      : store;
  // Explicit records may be partial. Lazy lookups already read canonical entries
  // and must retain their memo while the depth helper follows the parent chain.
  const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
    cfg: opts?.cfg,
    store: depthStore,
    agentId: opts?.agentId,
  });
  // Current policy is authoritative. Persisted role/scope describe the policy
  // at creation time and must not leave existing sessions permanently stale
  // after an operator changes the depth cap or upgrades to a new default.
  return resolveSubagentCapabilities({ depth, maxSpawnDepth });
}

function resolveStoredSubagentToolPolicy(
  sessionKey: string | undefined | null,
  opts?: { cfg?: OpenClawConfig; store?: SessionCapabilityStore },
) {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (
    !normalizedSessionKey ||
    !canInspectStoredSubagentEnvelope(normalizedSessionKey, opts?.store)
  ) {
    return undefined;
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
  });
  return { sessionKey: normalizedSessionKey, store, entry };
}

/** Resolve inherited tool deny rules stored on a subagent envelope. */
export function resolveStoredSubagentInheritedToolDenylist(
  sessionKey: string | undefined | null,
  opts?: { cfg?: OpenClawConfig; store?: SessionCapabilityStore },
): string[] {
  return normalizeInheritedToolDenylist(
    resolveStoredSubagentToolPolicy(sessionKey, opts)?.entry?.inheritedToolDeny,
  );
}

/** Resolve inherited tool allow rules stored on a subagent envelope. */
export function resolveStoredSubagentInheritedToolAllowlist(
  sessionKey: string | undefined | null,
  opts?: { cfg?: OpenClawConfig; store?: SessionCapabilityStore },
): string[] {
  return normalizeInheritedToolAllowlist(
    resolveStoredSubagentToolPolicy(sessionKey, opts)?.entry?.inheritedToolAllow,
  );
}
