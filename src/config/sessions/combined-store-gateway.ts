import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  canonicalizeSpawnedByForAgent,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import type { SessionStoreListOptions } from "./storage-adapter.js";
import { listSessionEntriesAsync, loadSessionStoreAsync } from "./store-async.js";
import { loadSessionStore } from "./store-load.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    const spawnedBy = canonicalizeSpawnedByForAgent(
      cfg,
      agentId,
      existing.spawnedBy ?? entry.spawnedBy,
    );
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy,
    };
    return;
  }

  const spawnedBy = canonicalizeSpawnedByForAgent(
    cfg,
    agentId,
    entry.spawnedBy ?? existing?.spawnedBy,
  );
  if (!existing && entry.spawnedBy === spawnedBy) {
    combined[canonicalKey] = entry;
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy,
    };
  }
}

type CombinedSessionStoreWindowOptions = {
  limit: number;
  offset?: number;
  agentId?: string;
  configuredAgentsOnly?: boolean;
  updatedAfter?: number;
  label?: string;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
};

export type CombinedSessionStoreWindow = {
  storePath: string;
  store: Record<string, SessionEntry>;
  totalCount: number;
  limitApplied: number;
  offset: number;
  nextOffset?: number;
  hasMore: boolean;
};

export type CombinedSessionStoreWindowDeniedReason =
  | "spawnedBy_runtime_context_required"
  | "search_runtime_context_required"
  | "shared_store_agent_filter_requires_full_store"
  | "shared_store_configured_filter_requires_full_store";

export type CombinedSessionStoreWindowDecision =
  | { allowed: true }
  | { allowed: false; reason: CombinedSessionStoreWindowDeniedReason };

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeNonNegativeInteger(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeOptionalLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function compareCombinedSessionEntriesByUpdatedAt(
  [leftKey, leftEntry]: [string, SessionEntry],
  [rightKey, rightEntry]: [string, SessionEntry],
): number {
  return (
    (rightEntry.updatedAt ?? 0) - (leftEntry.updatedAt ?? 0) || leftKey.localeCompare(rightKey)
  );
}

function excludedSpecialSessionKeys(opts: {
  includeGlobal?: boolean;
  includeUnknown?: boolean;
}): string[] | undefined {
  const exclude: string[] = [];
  if (opts.includeGlobal !== true) {
    exclude.push("global");
  }
  if (opts.includeUnknown !== true) {
    exclude.push("unknown");
  }
  return exclude.length > 0 ? exclude : undefined;
}

export function canUseCombinedSessionStoreWindowForGateway(
  cfg: OpenClawConfig,
  opts: {
    agentId?: string;
    configuredAgentsOnly?: boolean;
    spawnedBy?: string;
    search?: string;
  } = {},
): boolean {
  return resolveCombinedSessionStoreWindowDecisionForGateway(cfg, opts).allowed;
}

export function resolveCombinedSessionStoreWindowDecisionForGateway(
  cfg: OpenClawConfig,
  opts: {
    agentId?: string;
    configuredAgentsOnly?: boolean;
    spawnedBy?: string;
    search?: string;
  } = {},
): CombinedSessionStoreWindowDecision {
  if (opts.spawnedBy?.trim() || opts.search?.trim()) {
    return opts.spawnedBy?.trim()
      ? { allowed: false, reason: "spawnedBy_runtime_context_required" }
      : { allowed: false, reason: "search_runtime_context_required" };
  }
  const storeConfig = cfg.session?.store;
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    if (opts.agentId?.trim()) {
      return { allowed: false, reason: "shared_store_agent_filter_requires_full_store" };
    }
    if (opts.configuredAgentsOnly === true) {
      return { allowed: false, reason: "shared_store_configured_filter_requires_full_store" };
    }
  }
  return { allowed: true };
}

async function listStoreWindowForAgent(params: {
  cfg: OpenClawConfig;
  storePath: string;
  agentId: string;
  limit: number;
  excludeKeys?: readonly string[];
  updatedAfter?: number;
  label?: string;
}): Promise<{
  totalCount: number;
  entries: Array<[string, SessionEntry]>;
}> {
  const page = await listSessionEntriesAsync(params.storePath, {
    limit: params.limit,
    offset: 0,
    orderBy: "updatedAt_desc",
    excludeKeys: params.excludeKeys,
    ...(params.updatedAfter !== undefined ? { updatedAfter: params.updatedAfter } : {}),
    ...(params.label !== undefined ? { label: params.label } : {}),
  } satisfies SessionStoreListOptions);
  const entries = page.entries.map(([key, entry]) => [
    resolveStoredSessionKeyForAgentStore({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: key,
    }),
    entry,
  ]) satisfies Array<[string, SessionEntry]>;
  return { totalCount: page.totalCount, entries };
}

function selectCombinedWindow(params: {
  entries: Array<[string, SessionEntry]>;
  totalCount: number;
  limit: number;
  offset: number;
}): {
  store: CombinedSessionStoreWindow["store"];
  nextOffset?: number;
  hasMore: boolean;
} {
  const sorted = params.entries.toSorted(compareCombinedSessionEntriesByUpdatedAt);
  const page = sorted.slice(params.offset, params.offset + params.limit);
  const nextOffset =
    params.offset + page.length < params.totalCount ? params.offset + page.length : undefined;
  return {
    store: Object.fromEntries(page),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    hasMore: nextOffset !== undefined,
  };
}

export function loadCombinedSessionStoreForGateway(
  cfg: OpenClawConfig,
  opts: { agentId?: string; configuredAgentsOnly?: boolean } = {},
): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const store = loadSessionStore(storePath, { clone: false });
    const combined: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId: defaultAgentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId: defaultAgentId,
        canonicalKey,
      });
    }
    return { storePath, store: combined };
  }

  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  const targets = requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : opts.configuredAgentsOnly === true
      ? resolveSessionStoreTargets(cfg, { allAgents: true })
      : resolveAllAgentSessionStoreTargetsSync(cfg);
  const combined: Record<string, SessionEntry> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = loadSessionStore(storePath, { clone: false });
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  const storePath =
    targets.length === 1
      ? targets[0].storePath
      : typeof storeConfig === "string" && storeConfig.trim()
        ? storeConfig.trim()
        : "(multiple)";
  return { storePath, store: combined };
}

export async function loadCombinedSessionStoreForGatewayAsync(
  cfg: OpenClawConfig,
  opts: { agentId?: string; configuredAgentsOnly?: boolean } = {},
): Promise<{
  storePath: string;
  store: Record<string, SessionEntry>;
}> {
  const storeConfig = cfg.session?.store;
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const store = await loadSessionStoreAsync(storePath);
    const combined: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId: defaultAgentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId: defaultAgentId,
        canonicalKey,
      });
    }
    return { storePath, store: combined };
  }

  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  const targets = requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : opts.configuredAgentsOnly === true
      ? resolveSessionStoreTargets(cfg, { allAgents: true })
      : resolveAllAgentSessionStoreTargetsSync(cfg);
  const combined: Record<string, SessionEntry> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = await loadSessionStoreAsync(storePath);
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  const storePath =
    targets.length === 1
      ? targets[0].storePath
      : typeof storeConfig === "string" && storeConfig.trim()
        ? storeConfig.trim()
        : "(multiple)";
  return { storePath, store: combined };
}

/**
 * Loads only the requested sessions.list window through the async adapter list
 * API instead of materializing every session row. This is intentionally scoped
 * to simple list views; callers should fall back to
 * loadCombinedSessionStoreForGatewayAsync for filters that require a complete
 * in-memory child/search index.
 */
export async function loadCombinedSessionStoreWindowForGatewayAsync(
  cfg: OpenClawConfig,
  opts: CombinedSessionStoreWindowOptions,
): Promise<CombinedSessionStoreWindow> {
  const storeConfig = cfg.session?.store;
  const limit = normalizePositiveInteger(opts.limit, 100);
  const offset = normalizeNonNegativeInteger(opts.offset);
  const windowLimit = normalizePositiveInteger(offset + limit, limit);
  const excludeKeys = excludedSpecialSessionKeys(opts);
  const updatedAfter = normalizeOptionalTimestamp(opts.updatedAfter);
  const label = normalizeOptionalLabel(opts.label);
  const requestedAgentId = opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : undefined;

  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const listed = await listStoreWindowForAgent({
      cfg,
      storePath,
      agentId: defaultAgentId,
      limit: windowLimit,
      excludeKeys,
      updatedAfter,
      label,
    });
    const selected = selectCombinedWindow({
      entries: listed.entries,
      totalCount: listed.totalCount,
      limit,
      offset,
    });
    return {
      storePath,
      store: selected.store,
      totalCount: listed.totalCount,
      limitApplied: limit,
      offset,
      ...(selected.nextOffset !== undefined ? { nextOffset: selected.nextOffset } : {}),
      hasMore: selected.hasMore,
    };
  }

  const targets = requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : opts.configuredAgentsOnly === true
      ? resolveSessionStoreTargets(cfg, { allAgents: true })
      : resolveAllAgentSessionStoreTargetsSync(cfg);
  const combined: Record<string, SessionEntry> = {};
  let totalCount = 0;
  for (const target of targets) {
    const listed = await listStoreWindowForAgent({
      cfg,
      storePath: target.storePath,
      agentId: target.agentId,
      limit: windowLimit,
      excludeKeys,
      updatedAfter,
      label,
    });
    totalCount += listed.totalCount;
    for (const [key, entry] of listed.entries) {
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId: target.agentId,
        canonicalKey: key,
      });
    }
  }

  const selected = selectCombinedWindow({
    entries: Object.entries(combined),
    totalCount,
    limit,
    offset,
  });
  const storePath =
    targets.length === 1
      ? targets[0].storePath
      : typeof storeConfig === "string" && storeConfig.trim()
        ? storeConfig.trim()
        : "(multiple)";
  return {
    storePath,
    store: selected.store,
    totalCount,
    limitApplied: limit,
    offset,
    ...(selected.nextOffset !== undefined ? { nextOffset: selected.nextOffset } : {}),
    hasMore: selected.hasMore,
  };
}
