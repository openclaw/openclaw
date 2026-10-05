import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../agents/agent-scope.js";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveAgentMainSessionKey, type SessionEntry } from "../config/sessions.js";
import { collectCanonicalSessionLookupKeys } from "../config/sessions/main-session-key.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionMember } from "../config/sessions/session-sharing-store.kernel.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_AGENT_ID,
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  prepareSessionRowPublicationScope,
  sessionChangeAffectsStoredRow,
} from "../sessions/session-row-facts.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import {
  resolveSessionStoreIdentity,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import {
  resolveGatewaySessionStoreCandidates,
  resolveGatewaySessionStoreLookupCandidates,
  type GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-candidates.js";
import { GatewaySessionFactsChangedDuringReadError } from "./session-utils-store-errors.js";
import {
  loadGatewaySessionStoreReads,
  readGatewaySessionStore,
  type GatewaySessionStoreRead,
  type GatewaySessionStoreCache,
} from "./session-utils-store-read.js";
import {
  captureGatewaySessionReadSource,
  withIncognitoGatewaySessionStoreTarget,
} from "./session-utils-store-retained.js";
import {
  resolveGatewaySessionStoreReadResults,
  type GatewaySessionStoreLookup,
} from "./session-utils-store-selection.js";
import type {
  GatewaySessionStoreTarget,
  GatewaySessionStoreTargetWithStore,
} from "./session-utils-store.types.js";
export type { GatewaySessionStoreCache } from "./session-utils-store-read.js";

type GatewaySessionStoreLookupParams = {
  env?: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  preserveQualifiedAddress?: boolean;
  clone?: boolean;
  projection?: SessionEntryReadScope["projection"];
  readConsistency?: SessionEntryReadScope["readConsistency"];
  readOnly?: boolean;
  exactRead?: boolean;
  includeStoreChildEntries?: boolean;
  store?: Record<string, SessionEntry>;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
  readStore?: typeof readGatewaySessionStore;
};

type GatewaySessionStorePlan<T> = {
  reads: GatewaySessionStoreRead[];
  resolve: () => T;
};

function storeReadOptions(
  params: GatewaySessionStoreLookupParams,
  keys: string[],
  readOnly: boolean | undefined,
): GatewaySessionStoreRead["options"] {
  return {
    env: params.env,
    readOnly,
    ...(params.exactRead || params.preserveQualifiedAddress ? { exactKeys: keys } : {}),
    ...(params.projection ? { projection: params.projection } : {}),
    ...(params.readConsistency ? { readConsistency: params.readConsistency } : {}),
    ...(params.storeCache ? { cache: params.storeCache } : {}),
  };
}

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
    options: storeReadOptions(params, scanTargets, configured ? params.readOnly : true),
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
        readStore: params.readStore ?? readGatewaySessionStore,
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
    params.preserveQualifiedAddress ||
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
      options: storeReadOptions(params, lookupSeeds, true),
    }));
  return {
    reads,
    resolve: () => {
      if (reads.length === 0) {
        return null;
      }
      const best = resolveGatewaySessionStoreReadResults({
        reads,
        readStore: params.readStore ?? readGatewaySessionStore,
        scanTargets: lookupSeeds,
        canonicalKey,
      });
      if (!best.match) {
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
        ...(best.capturedReadSource ? { capturedReadSource: best.capturedReadSource } : {}),
        capturedReadSources: best.capturedReadSources,
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
    preserveQualifiedAddress: params.preserveQualifiedAddress,
  });
  if (isIncognitoSessionKey(canonicalKey)) {
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: params.env });
    const read: GatewaySessionStoreRead = {
      storePath,
      agentId,
      clone: params.clone,
      // Arbitrary stale keys must not materialize process-lifetime incognito state.
      options: storeReadOptions(params, [canonicalKey], true),
    };
    return {
      reads: [read],
      resolve: () => ({
        agentId,
        storePath,
        canonicalKey,
        storeKeys: [canonicalKey],
        store: (params.readStore ?? readGatewaySessionStore)(read),
        ...(read.readSource ? { readSource: read.readSource } : {}),
        ...(read.capturedReadSource
          ? {
              capturedReadSource: read.capturedReadSource,
              capturedReadSources: [read.capturedReadSource],
            }
          : {}),
      }),
    };
  }
  const storeKeys = params.preserveQualifiedAddress
    ? [canonicalKey]
    : collectCanonicalSessionLookupKeys({
        agentId,
        canonicalKey,
        mainKey: params.cfg.session?.mainKey,
        requestedKey: key,
      });
  const lookup = prepareGatewaySessionStoreLookup({ ...params, canonicalKey, agentId }, storeKeys);
  return {
    reads: lookup.reads,
    resolve: () => {
      const { storePath, store, readSource, capturedReadSource, capturedReadSources } =
        lookup.resolve();
      return {
        agentId,
        storePath,
        canonicalKey,
        storeKeys: [...storeKeys],
        store,
        ...(readSource ? { readSource } : {}),
        ...(capturedReadSource ? { capturedReadSource } : {}),
        ...(capturedReadSources ? { capturedReadSources } : {}),
      };
    },
  };
}

/** Prepare discovery before a writer uses transaction-local rows in the same routing selection. */
export function prepareGatewaySessionStoreTargetLookup(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore> {
  const normalized = { ...params, key: normalizeOptionalString(params.key) ?? "" };
  const deletedMain = prepareExplicitDeletedLegacyMainStoreTarget(normalized);
  let current: Result<GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore>, unknown>;
  try {
    current = ok(prepareGatewaySessionStoreTarget(normalized));
  } catch (error) {
    current = err(error);
  }
  return {
    reads: [...(deletedMain?.reads ?? []), ...(current.ok ? current.value.reads : [])],
    resolve() {
      const legacy = deletedMain?.resolve();
      if (legacy) {
        return legacy;
      }
      if (!current.ok) {
        throw current.error;
      }
      return current.value.resolve();
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

/** Retain discovery and exact worker rows through one synchronous authority consumer. */
export async function withGatewaySessionStoreTarget<T>(
  params: Pick<
    GatewaySessionStoreLookupParams,
    "cfg" | "key" | "agentId" | "env" | "projection"
  > & {
    includeMembership?: boolean;
  },
  consume: (
    target: GatewaySessionStoreTargetWithStore,
    membership: ReadonlyMap<string, readonly SessionMember[]>,
    assertCurrent: () => void,
  ) => T,
): Promise<T> {
  const normalized = {
    ...params,
    key: normalizeOptionalString(params.key) ?? "",
    exactRead: true,
    readOnly: true,
  };
  const identity = resolveSessionStoreIdentity({
    cfg: params.cfg,
    sessionKey: normalized.key,
    agentId: params.agentId,
  });
  if (isIncognitoSessionKey(identity.canonicalKey)) {
    return withIncognitoGatewaySessionStoreTarget({
      env: params.env,
      includeMembership: params.includeMembership,
      identity,
      resolve: () => resolveGatewaySessionStoreTargetWithStore(normalized),
      consume,
    });
  }
  const parsedAgentId = parseAgentSessionKey(normalized.key)?.agentId;
  const inventory = prepareSessionStoreTargetInventory(
    params.cfg,
    [identity.agentId, ...(parsedAgentId ? [parsedAgentId] : [])],
    params.env,
  );
  const inventoryRead = prepareSessionStoreTargetInventoryRead(inventory);
  return inventoryRead.withRead(async (sources, assertDiscoveryCurrent) => {
    const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
    for (const source of sources.agents) {
      if (!source.result.available && source.result.reason !== "database-missing") {
        throw new Error(
          `Session store discovery failed (${source.result.reason}); retry after storage is available.`,
        );
      }
      targetDiscoveryCache.set(source.agentId, {
        existing: source.result.available ? source.result.targets : [],
        fallback: {
          agentId: source.agentId,
          storePath: inventory.paths.get(source.agentId)!.configured,
        },
      });
    }
    const plan = prepareGatewaySessionStoreTargetLookup({
      ...normalized,
      cfg: inventory.config,
      env: inventory.env,
      targetDiscoveryCache,
    });
    const publications = plan.reads.map((read) => ({
      read,
      scope: prepareSessionRowPublicationScope([read.storePath]),
    }));
    let changed = false;
    const stop = sessionChanges.subscribeFacts((change) => {
      if (
        publications.some(({ read, scope }) =>
          sessionChangeAffectsStoredRow(change, {
            ...scope,
            agentId: read.agentId,
            sessionKeys: read.options.exactKeys ?? [],
          }),
        )
      ) {
        changed = true;
      }
    });
    let consumed = false;
    try {
      for (let attempt = 0; ; attempt += 1) {
        changed = false;
        assertDiscoveryCurrent();
        try {
          return await withSessionEntriesFromStoresInWorker(
            plan.reads.map((read) => ({
              agentId: read.agentId ?? identity.agentId,
              storePath: read.storePath,
              sessionKeys: read.options.exactKeys ?? [],
              // Admission needs complete member rows; list-only readers need sharing identities.
              projection:
                params.projection === "list" && !params.includeMembership ? "sharing" : "full",
              snapshotFields:
                typeof params.projection === "object"
                  ? params.projection
                  : params.projection === "list"
                    ? []
                    : undefined,
              includeMembers: params.includeMembership,
              includeAuthorization: true,
              env: inventory.env,
            })),
            (prepared) => {
              const assertCurrent = () => {
                assertDiscoveryCurrent();
                if (changed) {
                  throw new GatewaySessionFactsChangedDuringReadError();
                }
                for (const owner of prepared) {
                  owner.assertCurrent();
                }
              };
              for (const [index, read] of plan.reads.entries()) {
                const owner = prepared[index]!;
                read.result = ok(
                  Object.fromEntries(
                    owner.result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
                  ),
                );
                read.readSource = { agentId: owner.database.agentId, path: owner.database.path };
                read.capturedReadSource = captureGatewaySessionReadSource(
                  read.readSource,
                  owner.result.databaseIdentity,
                );
              }
              assertCurrent();
              const target = plan.resolve();
              const memberships = new Map<string, readonly SessionMember[]>();
              for (const owner of prepared) {
                if (owner.database.path === target.readSource?.path) {
                  for (const [key, members] of Object.entries(owner.result.members ?? {})) {
                    memberships.set(key, members);
                  }
                }
              }
              consumed = true;
              return consume(target, memberships, assertCurrent);
            },
            {
              ordered: params.includeMembership,
              onReadAdmitted: params.includeMembership
                ? () => {
                    assertDiscoveryCurrent();
                    // The ordered snapshot includes writes that settled before FIFO admission.
                    changed = false;
                  }
                : undefined,
              prepareSource(input, database, source) {
                for (const { read, scope } of publications) {
                  if (
                    read.storePath === input.storePath &&
                    (read.agentId ?? identity.agentId) === input.agentId
                  ) {
                    scope.prepareSource(database, source);
                  }
                }
              },
            },
          );
        } catch (error) {
          // The inventory still pins the original stores. Never repeat a consumer's effects.
          if (
            consumed ||
            attempt >= 1 ||
            !(error instanceof GatewaySessionFactsChangedDuringReadError)
          ) {
            throw error;
          }
        }
      }
    } finally {
      stop();
    }
  });
}

/** Worker readers fill the same ordered lookup plan before its synchronous selection. */
export async function prepareGatewaySessionStoreTargetReadOnly(
  params: GatewaySessionStoreLookupParams & {
    agentId: string;
    targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
  },
  prepareReads: <T>(reads: readonly GatewaySessionStoreRead[], select: () => T) => Promise<T>,
): Promise<GatewaySessionStoreTargetWithStore> {
  const normalized = {
    ...params,
    key: normalizeOptionalString(params.key) ?? "",
    exactRead: true,
    readOnly: true,
    projection: params.projection ?? ("list" as const),
  };
  const resolve = async <T>(plan: GatewaySessionStorePlan<T>) => {
    return await prepareReads(plan.reads, () => {
      if (plan.reads.some((read) => read.result === undefined)) {
        throw new Error("Session lookup facts were not prepared");
      }
      return plan.resolve();
    });
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

/** Read an already-stored lineage address without applying request aliases. */
export function readGatewayStoredSessionEntry(params: {
  cfg: OpenClawConfig;
  agentId: string;
  key: string;
  targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
}): SessionEntry | undefined {
  return prepareGatewaySessionStoreTarget({
    ...params,
    preserveQualifiedAddress: true,
    readOnly: true,
    exactRead: true,
    clone: false,
    projection: "list",
  }).resolve().store[params.key];
}

/** Resolve one synchronous set of logical metadata targets using exact grouped reads. */
function resolveGatewaySessionStoreTargetsReadOnly(params: {
  env?: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
  targets: readonly { key: string; agentId?: string }[];
  projection?: SessionEntryReadScope["projection"];
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
  projection: SessionEntryReadScope["projection"];
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
  // Routing needs canonical candidates, not a listing's unrelated rows and participants.
  const {
    store: _store,
    readSource: _readSource,
    capturedReadSource: _capturedReadSource,
    capturedReadSources: _capturedReadSources,
    ...target
  } = resolveGatewaySessionStoreTargetWithStore({
    ...params,
    projection: "list",
    exactRead: true,
    readOnly: false,
  });
  return target;
}
