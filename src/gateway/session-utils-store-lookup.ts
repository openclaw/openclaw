import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../agents/agent-scope.js";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import {
  isConfiguredSessionStoreAgentId,
  isPerAgentSessionStoreConfig,
  resolveAgentMainSessionKey,
  resolveExistingAgentSessionStoreTargetsSync,
  resolveSessionStorePathCore,
  type SessionEntry,
  type SessionStoreTarget,
} from "../config/sessions.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type {
  SessionEntryListScope,
  SessionEntryReadSource,
} from "../config/sessions/session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import type { ExistingAgentSessionStoreTargetResolver } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_AGENT_ID,
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import {
  resolveSessionStoreIdentity,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import {
  loadGatewaySessionStoreReads,
  readGatewaySessionStore,
  type GatewaySessionStoreRead,
  type GatewaySessionStoreCache,
} from "./session-utils-store-read.js";
import {
  findCanonicalStoreMatch,
  resolveGatewaySessionStoreReadResults,
  type GatewaySessionStoreLookup,
} from "./session-utils-store-selection.js";
import type {
  GatewaySessionStoreTarget,
  GatewaySessionStoreTargetWithStore,
} from "./session-utils-store.types.js";
export type { GatewaySessionStoreCache } from "./session-utils-store-read.js";

function buildGatewaySessionStoreScanTargets(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.key && params.key !== params.canonicalKey) {
    targets.add(params.key);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

type GatewaySessionStoreDiscovery = {
  existing: SessionStoreTarget[];
  fallback: SessionStoreTarget;
};

function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
  cache?: GatewaySessionStoreDiscoveryCache,
  excludeConfiguredFallback = false,
  env: NodeJS.ProcessEnv = process.env,
  registeredDatabases?: readonly { agentId: string; path: string }[],
  resolveExistingTargets?: ExistingAgentSessionStoreTargetResolver,
): GatewaySessionStoreDiscovery {
  const cached = cache?.get(agentId);
  if (cached) {
    return cached;
  }
  const storeConfig = cfg.session?.store;
  const fallback = {
    agentId,
    storePath: resolveSessionStorePathCore(storeConfig, { agentId, env }),
  };
  // Cached discovery also serves existing-only deleted-main lookups.
  const excludeStorePath =
    !cache && excludeConfiguredFallback && !isPerAgentSessionStoreConfig(storeConfig)
      ? fallback.storePath
      : undefined;
  const discovery = {
    existing: resolveExistingTargets
      ? resolveExistingTargets(agentId, excludeStorePath)
      : resolveExistingAgentSessionStoreTargetsSync(cfg, agentId, {
          env,
          registeredDatabases,
          excludeStorePath,
        }),
    fallback,
  };
  cache?.set(agentId, discovery);
  return discovery;
}

/**
 * Sharing resolves every returned row, but store targets are stable within one request.
 * Keep discovery agent-scoped here or each row repeats registry probes and agent-root scans.
 */
export type GatewaySessionStoreDiscoveryCache = Map<string, GatewaySessionStoreDiscovery>;

export function resolveGatewaySessionStoreLookupCandidates(params: {
  cfg: OpenClawConfig;
  agentId: string;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
  env?: NodeJS.ProcessEnv;
  registeredDatabases?: readonly { agentId: string; path: string }[];
  resolveExistingTargets?: ExistingAgentSessionStoreTargetResolver;
}): {
  configured: boolean;
  fallback: SessionStoreTarget;
  candidates: SessionStoreTarget[];
  readSources?: SessionEntryReadSource[];
} {
  const configured = isConfiguredSessionStoreAgentId(params.cfg, params.agentId);
  if (!configured && params.registeredDatabases) {
    // Prepared discovery already holds registered owners; don't rescan retired roots per page.
    const readSources = params.registeredDatabases
      .filter((source) => normalizeAgentId(source.agentId) === params.agentId)
      .map((source) => ({ agentId: source.agentId, path: source.path }));
    return {
      configured,
      fallback: {
        agentId: params.agentId,
        storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
          agentId: params.agentId,
          env: params.env,
        }),
      },
      candidates: readSources.map((source) => ({
        agentId: source.agentId,
        storePath: source.path,
      })),
      readSources,
    };
  }
  const { existing, fallback } = resolveGatewaySessionStoreCandidates(
    params.cfg,
    params.agentId,
    params.targetDiscoveryCache,
    configured,
    params.env,
    params.registeredDatabases,
    params.resolveExistingTargets,
  );
  return {
    configured,
    fallback,
    candidates: configured
      ? [fallback, ...existing.filter((target) => target.storePath !== fallback.storePath)]
      : existing,
  };
}

type GatewaySessionStoreLookupParams = {
  env?: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  clone?: boolean;
  projection?: SessionEntryListScope["projection"];
  readOnly?: boolean;
  exactRead?: boolean;
  listCandidatesOnly?: boolean;
  deferCanonicalValidation?: boolean;
  includeStoreChildEntries?: boolean;
  store?: Record<string, SessionEntry>;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
};

type GatewaySessionStorePlan<T> = {
  reads: GatewaySessionStoreRead[];
  resolve: () => T;
};

function prepareGatewaySessionStoreLookup(
  params: GatewaySessionStoreLookupParams & { canonicalKey: string; agentId: string },
  scanTargets: string[],
): GatewaySessionStorePlan<GatewaySessionStoreLookup> {
  const { configured, fallback, candidates } = resolveGatewaySessionStoreLookupCandidates(params);
  if (candidates.length === 0) {
    // Retired/manual agents require an existing discovered store; lookup never creates one.
    return {
      reads: [],
      resolve: () => ({ storePath: fallback.storePath, store: {}, match: undefined }),
    };
  }
  const reads = candidates.map((target, index): GatewaySessionStoreRead => ({
    storePath: target.storePath,
    agentId: target.agentId,
    clone: params.clone,
    options: {
      readOnly: configured ? params.readOnly : true,
      ...(params.exactRead ? { exactKeys: scanTargets } : {}),
      ...(params.listCandidatesOnly ? { listKeys: scanTargets } : {}),
      ...(params.projection ? { projection: params.projection } : {}),
      ...(params.storeCache ? { cache: params.storeCache } : {}),
    },
    result:
      index === 0 && target.storePath === fallback.storePath && params.store !== undefined
        ? ok(params.store)
        : undefined,
  }));
  return {
    reads,
    resolve: () =>
      resolveGatewaySessionStoreReadResults({
        ...params,
        reads,
        readStore: readGatewaySessionStore,
        scanTargets,
      }),
  };
}

function prepareExplicitDeletedLegacyMainStoreTarget(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore | null> | null {
  const parsed = parseAgentSessionKey(params.key);
  const legacyAgentId = normalizeAgentId(parsed?.agentId);
  if (
    !parsed ||
    isIncognitoSessionKey(params.key) ||
    legacyAgentId !== DEFAULT_AGENT_ID ||
    listAgentIds(params.cfg).includes(legacyAgentId)
  ) {
    return null;
  }
  // Deleted-main discovery precedes normal aliases; only a real matching row keeps this owner.
  const canonicalKey = resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: legacyAgentId,
    sessionKey: params.key,
  });
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: legacyAgentId });
  const lookupSeeds = Array.from(
    new Set([params.key, canonicalKey, agentMainKey, `agent:${legacyAgentId}:main`]),
  );
  const { existing } = resolveGatewaySessionStoreCandidates(
    params.cfg,
    legacyAgentId,
    params.targetDiscoveryCache,
    false,
    params.env,
  );
  const reads = existing
    .filter((target) => target.agentId === legacyAgentId)
    .map((target): GatewaySessionStoreRead => ({
      storePath: target.storePath,
      clone: params.clone,
      agentId: target.agentId,
      options: {
        readOnly: true,
        ...(params.exactRead ? { exactKeys: lookupSeeds } : {}),
        ...(params.listCandidatesOnly ? { listKeys: lookupSeeds } : {}),
        ...(params.projection ? { projection: params.projection } : {}),
        ...(params.storeCache ? { cache: params.storeCache } : {}),
      },
    }));
  return {
    reads,
    resolve: () => {
      let best:
        | {
            storePath: string;
            store: Record<string, SessionEntry>;
            match: { entry: SessionEntry; key: string };
            readSource?: SessionEntryReadSource;
          }
        | undefined;
      let canonicalValidationError: Error | undefined;
      const recordCanonicalError = params.deferCanonicalValidation
        ? (error: Error) => {
            canonicalValidationError ??= error;
          }
        : undefined;
      for (const target of reads) {
        const store = readGatewaySessionStore(target);
        const match = findCanonicalStoreMatch(store, lookupSeeds, recordCanonicalError);
        if (!match) {
          continue;
        }
        if (best) {
          const error = canonicalSessionKeyMigrationRequiredError(
            `duplicate rows resolve to canonical session key ${canonicalKey}`,
          );
          if (!recordCanonicalError) {
            throw error;
          }
          recordCanonicalError(error);
        }
        if (!best || (match.entry.updatedAt ?? 0) >= (best.match.entry.updatedAt ?? 0)) {
          best = {
            storePath: target.storePath,
            store,
            match,
            ...(target.readSource ? { readSource: target.readSource } : {}),
          };
        }
      }
      if (!best) {
        return null;
      }
      const storeKeys = new Set<string>([canonicalKey]);
      if (params.key !== canonicalKey) {
        storeKeys.add(params.key);
      }
      storeKeys.add(best.match.key);
      for (const seed of lookupSeeds) {
        storeKeys.add(seed);
      }
      return {
        agentId: legacyAgentId,
        storePath: best.storePath,
        canonicalKey,
        storeKeys: Array.from(storeKeys),
        store: best.store,
        ...(best.readSource ? { readSource: best.readSource } : {}),
        ...(canonicalValidationError ? { canonicalValidationError } : {}),
      };
    },
  };
}

function prepareGatewaySessionStoreTarget(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore> {
  const key = params.key;
  const { canonicalKey, agentId } = resolveSessionStoreIdentity({
    cfg: params.cfg,
    sessionKey: key,
    agentId: params.agentId,
  });
  if (isIncognitoSessionKey(canonicalKey)) {
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: params.env });
    const read: GatewaySessionStoreRead = {
      storePath,
      agentId,
      clone: params.clone,
      options: {
        // Arbitrary stale keys must not materialize process-lifetime incognito state.
        readOnly: true,
        ...(params.exactRead ? { exactKeys: [canonicalKey] } : {}),
        ...(params.listCandidatesOnly ? { listKeys: [canonicalKey] } : {}),
        ...(params.projection ? { projection: params.projection } : {}),
        ...(params.storeCache ? { cache: params.storeCache } : {}),
      },
    };
    return {
      reads: [read],
      resolve: () => ({
        agentId,
        storePath,
        canonicalKey,
        storeKeys: [canonicalKey],
        store: readGatewaySessionStore(read),
        ...(read.readSource ? { readSource: read.readSource } : {}),
      }),
    };
  }
  const storeKeys = buildGatewaySessionStoreScanTargets({ ...params, canonicalKey, agentId });
  const lookup = prepareGatewaySessionStoreLookup({ ...params, canonicalKey, agentId }, storeKeys);
  return {
    reads: lookup.reads,
    resolve: () => {
      const { canonicalValidationError, storePath, store, readSource } = lookup.resolve();
      return {
        agentId,
        storePath,
        canonicalKey,
        storeKeys: [...storeKeys],
        store,
        ...(readSource ? { readSource } : {}),
        ...(canonicalValidationError ? { canonicalValidationError } : {}),
      };
    },
  };
}

export function resolveGatewaySessionStoreTargetWithStore(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStoreTargetWithStore {
  const normalized = { ...params, key: normalizeOptionalString(params.key) ?? "" };
  const deletedMain = prepareExplicitDeletedLegacyMainStoreTarget(normalized)?.resolve();
  return includeDirectChildEntries(
    deletedMain ?? prepareGatewaySessionStoreTarget(normalized).resolve(),
    params.includeStoreChildEntries,
    params.cfg,
    params.env,
  );
}

/** Worker readers fill the same ordered lookup plan before its synchronous selection. */
export async function prepareGatewaySessionStoreTargetReadOnly(
  params: GatewaySessionStoreLookupParams & {
    agentId: string;
    targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
  },
  prepareReads: (reads: readonly GatewaySessionStoreRead[]) => Promise<void>,
): Promise<GatewaySessionStoreTargetWithStore> {
  const normalized = {
    ...params,
    key: normalizeOptionalString(params.key) ?? "",
    exactRead: true,
    readOnly: true,
    projection: "list" as const,
  };
  const resolve = async <T>(plan: GatewaySessionStorePlan<T>) => {
    await prepareReads(plan.reads);
    if (plan.reads.some((read) => read.result === undefined)) {
      throw new Error("Session lookup facts were not prepared");
    }
    return plan.resolve();
  };
  const deletedMain = prepareExplicitDeletedLegacyMainStoreTarget(normalized);
  if (deletedMain) {
    const target = await resolve(deletedMain);
    if (target) {
      return target;
    }
  }
  return await resolve(prepareGatewaySessionStoreTarget(normalized));
}

/** Exact row owners supply missing parent facts without expanding their selected store. */
export function createGatewaySessionEntryReader(params: {
  cfg: OpenClawConfig;
  agentId: string;
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
}): (key: string) => SessionEntry | undefined {
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  return (key) => {
    if (params.store[key]) {
      return params.store[key];
    }
    if (key === "global" || key === "unknown") {
      const readSource = params.readSource;
      if (!readSource) {
        return undefined;
      }
      // Raw lineage belongs to the selected physical store, not its child's logical agent.
      return readGatewaySessionStore({
        agentId: readSource.agentId,
        storePath: readSource.path,
        options: { readSource, readOnly: true, exactKeys: [key], projection: "list" },
      })[key];
    }
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg: params.cfg,
      key,
      // Unqualified parents are child-relative; qualified aliases retain their own owner.
      ...(parseAgentSessionKey(key) ? {} : { agentId: params.agentId }),
      readOnly: true,
      exactRead: true,
      clone: false,
      projection: "list",
      targetDiscoveryCache,
    });
    return target.store[target.canonicalKey];
  };
}

/** Resolve one synchronous set of logical metadata targets using exact grouped reads. */
export function resolveGatewaySessionStoreTargetsReadOnly(params: {
  env?: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
  targets: readonly { key: string; agentId?: string }[];
  projection?: SessionEntryListScope["projection"];
}): GatewaySessionStoreTargetWithStore[] {
  return readGatewaySessionStoreTargets(params, "eager").map((result) => {
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  });
}

/** Read exact groups now, retaining logical errors for the caller's ordered visitor. */
export function prepareGatewaySessionStoreTargetsReadOnly(params: {
  env?: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
  targets: readonly { key: string; agentId?: string }[];
  projection: SessionEntryListScope["projection"];
}): Array<Result<GatewaySessionStoreTargetWithStore, unknown>> {
  return readGatewaySessionStoreTargets(params, "prepared");
}

function readGatewaySessionStoreTargets(
  params: Parameters<typeof resolveGatewaySessionStoreTargetsReadOnly>[0],
  mode: "eager" | "prepared",
): Array<Result<GatewaySessionStoreTargetWithStore, unknown>> {
  const resolve = <T, U>(items: Result<T, unknown>[], read: (value: T) => U) =>
    items.map((item): Result<U, unknown> => {
      if (!item.ok) {
        return item;
      }
      try {
        return ok(read(item.value));
      } catch (error) {
        if (mode === "eager") {
          throw error;
        }
        return err(error);
      }
    });
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const requests = resolve(params.targets.map(ok), (target) => {
    const lookup: GatewaySessionStoreLookupParams = {
      ...target,
      key: normalizeOptionalString(target.key) ?? "",
      cfg: params.cfg,
      env: params.env,
      clone: false,
      readOnly: true,
      exactRead: true,
      projection: mode === "eager" ? (params.projection ?? "list") : params.projection,
      targetDiscoveryCache,
    };
    return { lookup, legacy: prepareExplicitDeletedLegacyMainStoreTarget(lookup) };
  });
  loadGatewaySessionStoreReads(
    requests.flatMap((request) => (request.ok ? (request.value.legacy?.reads ?? []) : [])),
  );
  const selected = resolve(requests, ({ lookup, legacy }) => {
    // Only a legacy miss permits fallback; a logical error must stay with its target.
    const target = legacy?.resolve();
    return target ? { reads: [], resolve: () => target } : prepareGatewaySessionStoreTarget(lookup);
  });
  loadGatewaySessionStoreReads(
    selected.flatMap((selection) => (selection.ok ? selection.value.reads : [])),
  );
  return resolve(selected, (selection) => selection.resolve());
}

function includeDirectChildEntries(
  target: GatewaySessionStoreTargetWithStore,
  include: boolean | undefined,
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): GatewaySessionStoreTargetWithStore {
  if (!include) {
    return target;
  }
  try {
    const parentKeys = new Set([target.canonicalKey, ...target.storeKeys]);
    const childKeys = new Set<string>();
    for (const parentKey of parentKeys) {
      for (const { sessionKey, entry } of listSessionChildEntriesReadOnly({
        agentId: target.agentId,
        env,
        clone: false,
        projection: "list",
        sessionKey: parentKey,
        storePath: target.storePath,
      })) {
        // Child discovery must not replace a selected full entry with metadata.
        if (!parentKeys.has(sessionKey)) {
          target.store[sessionKey] = entry;
        }
      }
    }
    for (const { childSessionKey } of listSubagentSessionListRunsForControllers([...parentKeys])) {
      childKeys.add(childSessionKey);
    }
    // Retained runs are discovery hints, not existence: deduplicate and batch exact reads.
    const targets = [...childKeys].filter((key) => !target.store[key]).map((key) => ({ key }));
    for (const child of resolveGatewaySessionStoreTargetsReadOnly({
      cfg,
      env,
      targets,
      projection: "list",
    })) {
      const entry = child.store[child.canonicalKey];
      if (entry && !parentKeys.has(child.canonicalKey)) {
        target.store[child.canonicalKey] = entry;
      }
    }
  } catch {
    // Match the existing read-only lookup contract: unavailable stores degrade to no rows.
  }
  return target;
}

export function resolveGatewaySessionStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  clone?: boolean;
  store?: Record<string, SessionEntry>;
}): GatewaySessionStoreTarget {
  // Keep listing validation and read mode while avoiding unrelated entry clones.
  const {
    store: _store,
    readSource: _readSource,
    ...target
  } = resolveGatewaySessionStoreTargetWithStore({
    ...params,
    projection: "list",
    listCandidatesOnly: true,
  });
  return target;
}
