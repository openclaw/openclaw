// Builds the gateway-visible combined session store across agent-specific stores.
// Gateway callers need canonical per-agent keys even when stores are split by `{agentId}`.

import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../agents/agent-scope.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import {
  listOpenClawRegisteredAgentDatabases,
  listOpenIncognitoAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
  readOpenIncognitoAgentDatabaseGeneration,
} from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveSessionStoreCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  createSessionModelSources,
  type GatewayStoredSessionTarget,
  type GatewayStoredSessionTargets,
} from "./combined-store-model-sources.js";
import {
  createGatewayRetainedStoreMatcher,
  discoveryReadOptions,
  isStorePathTemplate,
  resolveSharedStoreRowOwner,
  type GatewaySessionStoreDiscovery,
  resolveCombinedDatabasePath,
  resolveCombinedStorePath,
  storeTargetKey,
} from "./combined-store-paths.js";
import { canonicalizeMainSessionAlias } from "./main-session.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { listSessionEntriesCore, listSessionEntriesReadOnly } from "./session-accessor.js";
import type { SessionEntryListScope, SessionEntrySummary } from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  listConfiguredSessionStoreAgentIds,
  listKnownSessionStoreAgentIds,
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  type SessionStoreTarget,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

type GatewaySessionEntryProjection = NonNullable<SessionEntryListScope["projection"]>;

export type {
  GatewayStoredSessionTarget,
  GatewayStoredSessionTargets,
} from "./combined-store-model-sources.js";

function capturePhysicalStoreTargets() {
  const physicalTargets = new Map<string, SessionStoreTarget>();
  return {
    physicalTargets,
    onResolvedTarget: (selected: SessionStoreTarget, physical: SessionStoreTarget) => {
      physicalTargets.set(storeTargetKey(selected), physical);
    },
  };
}

type GatewaySessionStoreOptions = {
  discovery?: GatewaySessionStoreDiscovery;
  agentId?: string;
  configuredAgentsOnly?: boolean;
  includeIncognito?: boolean;
  projection?: SessionEntryListScope["projection"];
  /** Keep per-agent sentinel rows distinct internally; public reads restore their raw key. */
  preserveSentinelOwners?: boolean | "physical";
  /** Durable stores may use resident entries; incognito retains its existing lifetime. */
  loadEntries?: (
    target: SessionStoreTarget,
    projection: GatewaySessionEntryProjection,
  ) => ReturnType<typeof loadGatewayStoreEntries>;
  onStoreLoaded?: (
    target: SessionStoreTarget,
    rowAgentId: string,
    discovery: { agentId: string; order: number } | null,
  ) => void;
};

type ResolvedGatewaySessionStoreTargets = {
  groupDiscovery?: ReadonlyMap<string, { agentId: string; order: number }>;
  configuredAgentIds?: ReadonlySet<string>;
  defaultAgentId: string;
  diagnostics: readonly string[];
  durableStorePath?: string;
  durableTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
  incognitoTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
  physicalTargets: ReadonlyMap<string, SessionStoreTarget>;
  requestedAgentId?: string;
  preparedAgentIds?: Set<string>;
  sharedStoreRowOwner?: { agentId: string; target: SessionStoreTarget };
  storeConfig?: string;
};

type PreparedConfiguredSessionStoreTargets = {
  cfg: OpenClawConfig;
  includeIncognito: boolean;
  incognitoGeneration: number;
  registryToken: symbol;
  resolved: ResolvedGatewaySessionStoreTargets;
};

// Gateway aliases, config, registry, and incognito topology are process-stable until
// an explicit generation change or restart; generic CLI/Doctor dedupe stays fresh.
let preparedConfiguredSessionStoreTargets: PreparedConfiguredSessionStoreTargets | undefined;

function loadGatewayStoreEntries(params: {
  agentId: string;
  includeOpenDatabases?: boolean;
  projection: GatewaySessionEntryProjection;
  storePath: string;
}) {
  const listEntries = params.includeOpenDatabases
    ? listSessionEntriesCore
    : listSessionEntriesReadOnly;
  return listEntries({
    agentId: params.agentId,
    clone: false,
    projection: params.projection,
    storePath: params.storePath,
  });
}

// The listing accessor owns delivery-key validation; federation owns config aliases and targets.
function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  targetsBySessionKey: Map<string, GatewayStoredSessionTarget>;
  entry: SessionEntry;
  target: GatewayStoredSessionTarget;
  canonicalKey: string;
  projectedKey?: string;
}) {
  const { combined, entry, target, canonicalKey } = params;
  const projectedKey = params.projectedKey ?? canonicalKey;
  const existing = combined[projectedKey];
  if (existing && (canonicalKey === "global" || canonicalKey === "unknown")) {
    // Reserved sentinels keep their per-store source; target order owns the combined projection.
    return;
  }
  if (existing) {
    throw canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${canonicalKey}`,
    );
  }
  combined[projectedKey] = entry;
  params.targetsBySessionKey.set(projectedKey, target);
}

export function projectGatewaySessionEntry(
  cfg: OpenClawConfig,
  entry: SessionEntry,
  resolveSourceKey?: (key: string) => string,
): SessionEntry {
  const projected = { ...entry };
  // Global display uses the captured parent selection; per-sender lineage stays literal.
  // Raw sentinels keep their physical owner and are never reinterpreted here.
  if (cfg.session?.scope === "global") {
    for (const field of ["parentSessionKey", "spawnedBy"] as const) {
      const sessionKey = projected[field];
      const parsed = sessionKey ? parseAgentSessionKey(sessionKey) : null;
      if (sessionKey && parsed) {
        projected[field] =
          resolveSourceKey?.(sessionKey) ??
          canonicalizeMainSessionAlias({ cfg, agentId: parsed.agentId, sessionKey });
      }
    }
  }
  return projected;
}

function mergeOpenIncognitoStores(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  targetsBySessionKey: Map<string, GatewayStoredSessionTarget>;
  modelSources: ReturnType<typeof createSessionModelSources>;
  projection: GatewaySessionEntryProjection;
  targets: ReadonlyArray<{ agentId: string; storePath: string }>;
}): string[] {
  const storePaths: string[] = [];
  for (const target of params.targets) {
    const store = loadGatewayStoreEntries({
      agentId: target.agentId,
      includeOpenDatabases: true,
      projection: params.projection,
      storePath: target.storePath,
    });
    let merged = false;
    const addModelEntry = params.modelSources.prepareStore(target);
    const modelTarget = { agentId: target.agentId, storeTarget: target };
    for (const { sessionKey, entry } of store) {
      if (!isIncognitoSessionKey(sessionKey) || entry.incognito !== true) {
        continue;
      }
      mergeSessionEntryIntoCombined({
        cfg: params.cfg,
        combined: params.combined,
        targetsBySessionKey: params.targetsBySessionKey,
        entry,
        target: {
          ...modelTarget,
          entry,
          ...addModelEntry(target.agentId, sessionKey, entry),
        },
        canonicalKey: sessionKey,
      });
      merged = true;
    }
    if (merged) {
      storePaths.push(target.storePath);
    }
  }
  return storePaths;
}

export function isConfiguredGatewaySessionEntry(
  cfg: OpenClawConfig,
  configuredAgentIds: ReadonlySet<string>,
  key: string,
  entry: SessionEntry,
): boolean {
  const isConfiguredSessionKey = (candidate: string | undefined) => {
    const normalizedKey = normalizeOptionalString(candidate);
    return Boolean(
      normalizedKey &&
      configuredAgentIds.has(normalizeAgentId(resolveSessionStoreAgentId(cfg, normalizedKey))),
    );
  };
  return (
    key === "global" ||
    key === "unknown" ||
    isConfiguredSessionKey(key) ||
    isConfiguredSessionKey(entry.spawnedBy) ||
    isConfiguredSessionKey(entry.parentSessionKey)
  );
}

function filterCombinedStoreToConfiguredAgents(params: {
  cfg: OpenClawConfig;
  configuredAgentIds: ReadonlySet<string>;
  store: Record<string, SessionEntry>;
  targetsBySessionKey: Map<string, GatewayStoredSessionTarget>;
  modelSources: ReturnType<typeof createSessionModelSources>;
}): void {
  for (const [key, entry] of Object.entries(params.store)) {
    const storeKey = params.targetsBySessionKey.get(key)?.storeKey ?? key;
    const keep = isConfiguredGatewaySessionEntry(
      params.cfg,
      params.configuredAgentIds,
      storeKey,
      entry,
    );
    if (!keep) {
      params.modelSources.remove(
        expectDefined(params.targetsBySessionKey.get(key), "filtered row target"),
        storeKey,
      );
      delete params.store[key];
      params.targetsBySessionKey.delete(key);
    }
  }
}

function resolvePreparedConfiguredSessionStoreTargets(
  cfg: OpenClawConfig,
  includeIncognito: boolean,
  discovery?: GatewaySessionStoreDiscovery,
): ResolvedGatewaySessionStoreTargets {
  const readOptions = discoveryReadOptions(discovery);
  const registryToken = discovery ? undefined : readOpenClawAgentDatabaseRegistryToken();
  const incognitoGeneration = readOpenIncognitoAgentDatabaseGeneration();
  const cached = discovery ? undefined : preparedConfiguredSessionStoreTargets;
  if (
    cached?.cfg === cfg &&
    cached.registryToken === registryToken &&
    cached.incognitoGeneration === incognitoGeneration &&
    cached.includeIncognito === includeIncognito
  ) {
    return cached.resolved;
  }

  const storeConfig = cfg.session?.store;
  const defaultAgentId = normalizeAgentId(resolveSessionStoreCompatibilityAgentId(cfg));
  const configuredIds = listConfiguredSessionStoreAgentIds(cfg);
  const configuredAgentIds = new Set(configuredIds);
  const incognitoTargets = includeIncognito ? listOpenIncognitoAgentDatabases() : [];
  const incognitoTargetKeys = new Set(
    incognitoTargets.map((target) => `${target.agentId}\0${target.storePath}`),
  );
  const diagnostics: string[] = [];
  const { physicalTargets, onResolvedTarget } = capturePhysicalStoreTargets();
  let sharedStoreRowOwner: ResolvedGatewaySessionStoreTargets["sharedStoreRowOwner"];
  const candidates = dedupeSessionStoreTargetsBySqliteTarget(
    [
      ...(readOptions.registeredDatabases ?? listOpenClawRegisteredAgentDatabases()).map(
        ({ agentId, path }) => ({
          agentId,
          storePath: path,
        }),
      ),
      ...configuredIds.map((agentId) => ({
        agentId,
        storePath: resolveSessionStorePathCore(storeConfig, { agentId, env: readOptions.env }),
      })),
      ...incognitoTargets,
    ],
    {
      defaultAgentId,
      ...readOptions,
      onResolvedTarget,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      onSharedTarget: (selected, paths) => {
        sharedStoreRowOwner ??= resolveSharedStoreRowOwner(cfg, selected, paths, readOptions.env);
      },
    },
  );
  const durableTargets = candidates.filter(
    (target) => !incognitoTargetKeys.has(`${target.agentId}\0${target.storePath}`),
  );
  const resolved = Object.freeze({
    configuredAgentIds,
    defaultAgentId,
    diagnostics: Object.freeze(diagnostics),
    durableStorePath: resolveCombinedDatabasePath(durableTargets, physicalTargets),
    durableTargets: Object.freeze(durableTargets.map((target) => Object.freeze({ ...target }))),
    incognitoTargets: Object.freeze(
      candidates
        .filter((target) => incognitoTargetKeys.has(`${target.agentId}\0${target.storePath}`))
        .map((target) => Object.freeze({ ...target })),
    ),
    sharedStoreRowOwner,
    physicalTargets,
    storeConfig,
  });
  if (registryToken) {
    preparedConfiguredSessionStoreTargets = {
      cfg,
      includeIncognito,
      incognitoGeneration,
      registryToken,
      resolved,
    };
  }
  return resolved;
}

function resolveGatewaySessionStoreTopology(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions,
): ResolvedGatewaySessionStoreTargets {
  const readOptions = discoveryReadOptions(opts.discovery);
  const storeConfig = cfg.session?.store;
  const diagnostics: string[] = [];
  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  if (opts.configuredAgentsOnly === true && !requestedAgentId) {
    return resolvePreparedConfiguredSessionStoreTargets(
      cfg,
      opts.includeIncognito !== false,
      opts.discovery,
    );
  }
  const defaultAgentId = normalizeAgentId(resolveSessionStoreCompatibilityAgentId(cfg));
  const { physicalTargets, onResolvedTarget } = capturePhysicalStoreTargets();
  const incognitoTargets =
    opts.includeIncognito === false
      ? []
      : listOpenIncognitoAgentDatabases().filter(
          (target) => !requestedAgentId || target.agentId === requestedAgentId,
        );

  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const ownerIds = [
      ...new Set([
        ...listAgentEntries(cfg).map((entry) => normalizeAgentId(entry.id)),
        ...listKnownSessionStoreAgentIds(cfg, readOptions),
        defaultAgentId,
        ...(requestedAgentId ? [requestedAgentId] : []),
      ]),
    ];
    let sharedStoreRowOwner: ResolvedGatewaySessionStoreTargets["sharedStoreRowOwner"];
    const durableTargets = dedupeSessionStoreTargetsBySqliteTarget(
      ownerIds.map((agentId) => ({
        agentId,
        storePath: resolveSessionStorePathCore(storeConfig, { agentId, env: readOptions.env }),
      })),
      {
        defaultAgentId,
        ...readOptions,
        onResolvedTarget,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
        onSharedTarget: (selected, paths) => {
          sharedStoreRowOwner ??= resolveSharedStoreRowOwner(cfg, selected, paths, readOptions.env);
        },
      },
    );
    return {
      defaultAgentId,
      diagnostics,
      durableTargets,
      incognitoTargets,
      requestedAgentId,
      preparedAgentIds: requestedAgentId ? new Set(ownerIds) : undefined,
      sharedStoreRowOwner,
      physicalTargets,
      storeConfig,
    };
  }

  const durableTargets = requestedAgentId
    ? dedupeSessionStoreTargetsBySqliteTarget(
        resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId, readOptions),
        { defaultAgentId, onResolvedTarget, ...readOptions },
      )
    : resolveAllAgentSessionStoreTargetsSync(cfg, { onResolvedTarget, ...readOptions });
  return {
    defaultAgentId,
    diagnostics,
    durableTargets,
    incognitoTargets,
    physicalTargets,
    requestedAgentId,
    preparedAgentIds: requestedAgentId ? new Set([requestedAgentId]) : undefined,
    storeConfig,
  };
}

export function resolveGatewaySessionStoreTargets(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions = {},
): ResolvedGatewaySessionStoreTargets {
  const readOptions = discoveryReadOptions(opts.discovery);
  if (opts.agentId?.trim()) {
    assertAgentDatabaseAdmitted(opts.agentId, { env: readOptions.env });
  }
  let resolved = resolveGatewaySessionStoreTopology(cfg, opts);
  if (opts.preserveSentinelOwners === "physical") {
    const { physicalTargets, onResolvedTarget } = capturePhysicalStoreTargets();
    // Group discovery keeps its claimant/order before the full roster adds registered stores.
    const groupDiscovery = new Map<string, { agentId: string; order: number }>();
    const discoveredTargets = resolveAllAgentSessionStoreTargetsSync(cfg, {
      ...readOptions,
      onResolvedTarget: ({ agentId }, physical) =>
        groupDiscovery.set(physical.storePath, {
          agentId,
          order: groupDiscovery.size,
        }),
    });
    const durableTargets = dedupeSessionStoreTargetsBySqliteTarget(
      [
        ...resolved.durableTargets,
        ...discoveredTargets,
        ...(readOptions.registeredDatabases ?? listOpenClawRegisteredAgentDatabases())
          .filter(
            ({ path }) =>
              ![...resolved.physicalTargets.values()].some((target) => target.storePath === path),
          )
          .map(({ agentId, path }) => ({ agentId, storePath: path })),
      ],
      { defaultAgentId: resolved.defaultAgentId, onResolvedTarget, ...readOptions },
    );
    resolved = { ...resolved, durableTargets, physicalTargets, groupDiscovery };
  }
  const diagnostics = [...resolved.diagnostics];
  const env = readOptions.env ?? process.env;
  const deleted = createGatewayRetainedStoreMatcher(cfg, opts.discovery);
  const admitted = (target: SessionStoreTarget, durable = false): boolean => {
    const physical = resolved.physicalTargets.get(storeTargetKey(target));
    if (durable && deleted(physical?.storePath ?? target.storePath, target.agentId)) {
      return false;
    }
    const refusal =
      readAgentDatabaseAdmissionRefusal(target.agentId, { env }) ??
      (physical && readAgentDatabaseAdmissionRefusal(physical.agentId, { env }));
    if (!refusal) {
      return true;
    }
    const message = `${refusal.reason}\n${refusal.repairHint}`;
    if (!diagnostics.includes(message)) {
      diagnostics.push(message);
    }
    return false;
  };
  // Cached topology stays complete; each boot's admission is applied when consumed.
  const durableTargets = resolved.durableTargets.filter((target) => admitted(target, true));
  const incognitoTargets = resolved.incognitoTargets.filter((target) => admitted(target));
  if (
    durableTargets.length === resolved.durableTargets.length &&
    incognitoTargets.length === resolved.incognitoTargets.length
  ) {
    return resolved;
  }
  return {
    ...resolved,
    diagnostics,
    durableTargets,
    incognitoTargets,
    ...(resolved.durableStorePath === undefined
      ? {}
      : {
          durableStorePath: resolveCombinedDatabasePath(durableTargets, resolved.physicalTargets),
        }),
  };
}

/** Loads and canonicalizes session entries for gateway views across one or more agent stores. */
type GatewayCombinedSessionStore = {
  diagnostics?: readonly string[];
  durableStorePath?: string;
  durableTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
  storePath: string;
  store: Record<string, SessionEntry>;
  targetsBySessionKey: GatewayStoredSessionTargets;
};

function prepareCombinedSessionStore(cfg: OpenClawConfig, opts: GatewaySessionStoreOptions) {
  const targets = resolveGatewaySessionStoreTargets(cfg, opts);
  return {
    projection: opts.projection ?? "list",
    targets,
    reads: targets.durableTargets.map((target) => ({
      target,
      storeTarget: expectDefined(
        targets.physicalTargets.get(storeTargetKey(target)),
        "physical store",
      ),
    })),
  };
}

function mergeCombinedSessionStore(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions,
  prepared: ReturnType<typeof prepareCombinedSessionStore>,
  readEntries: (target: SessionStoreTarget) => SessionEntrySummary[],
): GatewayCombinedSessionStore {
  const env = opts.discovery?.env;
  // Store-wide metadata reads must not materialize saved prompts for every row.
  // Consumers of retained prompt fields opt into the full projection.
  const { projection } = prepared;
  // Admission and projection share the prepared target set.
  const {
    configuredAgentIds,
    diagnostics,
    durableStorePath: preparedDurableStorePath,
    durableTargets,
    incognitoTargets,
    physicalTargets,
    requestedAgentId,
    preparedAgentIds,
    sharedStoreRowOwner,
    storeConfig,
  } = prepared.targets;
  const combined: Record<string, SessionEntry> = {};
  // Federation chooses both the logical owner and physical store once. Fresh reads
  // must not re-admit a sentinel through public aliases or select a different store.
  const targetsBySessionKey = new Map<string, GatewayStoredSessionTarget>();
  const projectionDiagnostics = [...diagnostics];
  const modelSources = createSessionModelSources(cfg, projectionDiagnostics, preparedAgentIds);
  for (const { target, storeTarget } of prepared.reads) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = readEntries(storeTarget);
    assertAgentDatabaseAdmitted(agentId, { env });
    assertAgentDatabaseAdmitted(storeTarget.agentId, { env });
    // Legacy selector paths can be shared by distinct physical agent partitions.
    const rowAgentId =
      sharedStoreRowOwner?.target.storePath === storePath &&
      sharedStoreRowOwner.target.agentId === agentId
        ? sharedStoreRowOwner.agentId
        : agentId;
    opts.onStoreLoaded?.(
      storeTarget,
      rowAgentId,
      prepared.targets.groupDiscovery?.get(storeTarget.storePath) ?? null,
    );
    // Completeness comes from loaded targets, even when their rows are empty or filtered.
    preparedAgentIds?.add(agentId);
    preparedAgentIds?.add(storeTarget.agentId);
    preparedAgentIds?.add(rowAgentId);
    const addModelEntry = modelSources.prepareStore(storeTarget);
    for (const { sessionKey: key, entry } of store) {
      const parsed = parseAgentSessionKey(key);
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        // Qualified retired-owner keys keep their physical store's canonicalization context.
        agentId: parsed ? storeTarget.agentId : rowAgentId,
        sessionKey: key,
        preserveQualifiedAddress: true,
      });
      if (key !== canonicalKey) {
        throw canonicalSessionKeyMigrationRequiredError(
          `non-canonical persisted row resolves to session key ${canonicalKey}`,
        );
      }
      const canonicalAgentId = normalizeAgentId(parsed?.agentId ?? rowAgentId);
      preparedAgentIds?.add(canonicalAgentId);
      // A scoped row can inherit a differently owned parent from this same physical store.
      const source = addModelEntry(canonicalAgentId, canonicalKey, entry);
      if (requestedAgentId && canonicalAgentId !== requestedAgentId) {
        continue;
      }
      // Canonical stored keys are agent-prefixed or raw sentinels; this private
      // pair cannot collide with a literal agent:<id>:global or :unknown session.
      const projectedKey =
        opts.preserveSentinelOwners && (canonicalKey === "global" || canonicalKey === "unknown")
          ? JSON.stringify([
              canonicalKey,
              opts.preserveSentinelOwners === "physical"
                ? `${canonicalAgentId}\0${storeTarget.storePath}`
                : canonicalAgentId,
            ])
          : canonicalKey;
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        targetsBySessionKey,
        entry,
        target: {
          agentId: canonicalAgentId,
          storeTarget,
          entry,
          ...source,
          ...(projectedKey !== canonicalKey ? { storeKey: canonicalKey } : {}),
        },
        canonicalKey,
        projectedKey,
      });
    }
  }

  const incognitoStorePaths = mergeOpenIncognitoStores({
    cfg,
    combined,
    targetsBySessionKey,
    modelSources,
    projection,
    targets: incognitoTargets,
  });
  if (configuredAgentIds) {
    filterCombinedStoreToConfiguredAgents({
      cfg,
      configuredAgentIds,
      store: combined,
      targetsBySessionKey,
      modelSources,
    });
  }

  // Parent selection must see later stores too, before display/filter lineage is projected.
  for (const [key, target] of targetsBySessionKey) {
    combined[key] = projectGatewaySessionEntry(cfg, combined[key]!, target.resolveSourceKey);
  }

  const durableStorePaths = durableTargets.map((target) => target.storePath);
  const durableStorePath =
    preparedDurableStorePath ?? resolveCombinedDatabasePath(durableTargets, physicalTargets);
  const storePath =
    storeConfig && !isStorePathTemplate(storeConfig)
      ? incognitoStorePaths.length > 0
        ? "(multiple)"
        : durableStorePath
      : resolveCombinedStorePath([...durableStorePaths, ...incognitoStorePaths], storeConfig);
  return {
    diagnostics: projectionDiagnostics,
    durableStorePath,
    durableTargets,
    storePath,
    store: combined,
    targetsBySessionKey,
  };
}

export function loadCombinedSessionStoreForGatewayCore(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions = {},
): GatewayCombinedSessionStore {
  const prepared = prepareCombinedSessionStore(cfg, opts);
  return mergeCombinedSessionStore(cfg, opts, prepared, (target) =>
    opts.loadEntries
      ? opts.loadEntries(target, prepared.projection)
      : loadGatewayStoreEntries({ ...target, projection: prepared.projection }),
  );
}

/** Descriptive listings retain federation policy while durable rows are read by its worker. */
export async function loadCombinedSessionStoreForGatewayCoreAsync(
  cfg: OpenClawConfig,
  opts: Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded"> = {},
): Promise<GatewayCombinedSessionStore> {
  const options = { ...opts };
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const prepared = prepareCombinedSessionStore(cfg, options);
  // Preparation can refresh registry discovery; retain its resulting topology generation.
  const registryToken = readOpenClawAgentDatabaseRegistryToken();
  const incognitoGeneration = readOpenIncognitoAgentDatabaseGeneration();
  // Windows environment proxies cannot cross the worker boundary.
  const transferEnv = { ...env, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR };
  return await withSessionHistoryWorkerDatabases(
    prepared.reads.map(({ storeTarget }) => ({
      agentId: storeTarget.agentId,
      path: storeTarget.storePath,
      env,
    })),
    async (owners) => {
      const entries = new Map<string, SessionEntrySummary[]>();
      for (const [index, { storeTarget }] of prepared.reads.entries()) {
        const owner = expectDefined(owners[index], "retained session store");
        const rows = await owner.readEntries({
          ...storeTarget,
          env: transferEnv,
          projection: prepared.projection,
          clone: false,
        });
        entries.set(storeTargetKey(storeTarget), rows);
      }
      for (const owner of owners) {
        owner.assertCurrent();
      }
      if (
        registryToken !== readOpenClawAgentDatabaseRegistryToken() ||
        incognitoGeneration !== readOpenIncognitoAgentDatabaseGeneration()
      ) {
        throw new Error("Session stores changed while preparing the listing. Retry the request.");
      }
      // The merger rechecks admission and reads process-local incognito handles at consumption.
      return mergeCombinedSessionStore(cfg, options, prepared, (target) =>
        expectDefined(entries.get(storeTargetKey(target)), "prepared session entries"),
      );
    },
  );
}
