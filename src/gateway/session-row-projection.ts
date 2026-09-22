import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.publication-events.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import {
  loadCombinedSessionStoreForGatewayCore,
  projectGatewaySessionEntry,
} from "../config/sessions/combined-store-gateway.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { readCommittedSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import {
  listSessionEntriesReadOnly,
  resolveSessionKeyBySessionId,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionMembers } from "../config/sessions/session-sharing-store.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { listOpenIncognitoAgentDatabases } from "../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { retainUserProfileCatalog } from "../state/user-profile-list.js";
import { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { compareSessionEntryPairs } from "./session-list-order.js";
import { yieldSessionListWork } from "./session-projection-work.js";
import * as records from "./session-row-projection-record.js";
import { prepareSessionRowScopes } from "./session-row-scope.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { materializeSessionRow, readSessionRowInputs } from "./session-utils-row.js";
import {
  createGatewaySessionEntryReader,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils-store-lookup.js";
import { resolveDeletedAgentIdFromSessionKey } from "./session-utils-store.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  modelCatalog?: records.Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<records.Inputs["modelCatalog"]>;
  context?: Parameters<typeof readSessionRowFacts>[0]["context"];
}) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let cfg = params.cfg;
  let modelCatalog = params.modelCatalog;
  const rows = new Map<string, records.Row>();
  let stores = new Map<
    string,
    { target: SessionStoreTarget; agentId: string; identity: string | symbol; filename: string }
  >();
  const byStore = new Map<string, Set<string>>(),
    byAgent = new Map<string, Set<string>>();
  const byParent = new Map<string, Set<string>>(),
    byKey = new Map<string, Set<string>>();
  const dirty = new Set<string>();
  let topologyDirty = true,
    catalogDirty = params.getModelCatalog ? Symbol("catalog") : undefined,
    disposed = false;
  let epoch = 0,
    preparedEpoch = -1;
  let materializedCount = 0;
  let scope: ReturnType<typeof prepareSessionRowScopes>;
  let pending: Promise<void> | undefined;
  let context = buildSessionListRowMetadataContext({ now: Date.now() });
  const subagentInputs = context.subagentRuns.inputs;
  function index(row: records.Row, deleting = false) {
    const id = records.identity(row);
    for (const [map, keys] of [
      [byStore, [row.storeTarget.storePath]],
      [byAgent, [row.agentId]],
      [
        byKey,
        [`key:${row.key}`, row.entry && `id:${row.entry.sessionId}`, ...records.references(row)],
      ],
      [byParent, row.parents],
    ] satisfies [Map<string, Set<string>>, Iterable<string | undefined>][]) {
      for (const key of keys) {
        if (key) {
          const values = map.get(key) ?? new Set<string>();
          if (deleting) {
            values.delete(id);
          } else {
            values.add(id);
          }
          if (values.size) {
            map.set(key, values);
          } else {
            map.delete(key);
          }
        }
      }
    }
  }
  function dependents(row: records.Row) {
    return new Set(records.references(row).flatMap((ref) => Array.from(byParent.get(ref) ?? [])));
  }
  function related(row: records.Row) {
    for (const id of dependents(row)) {
      dirty.add(id);
    }
    for (const parent of row.parents) {
      for (const id of byKey.get(parent) ?? []) {
        dirty.add(id);
      }
    }
  }
  function remove(id: string) {
    const row = rows.get(id);
    if (row) {
      related(row);
      index(row, true);
      rows.delete(id);
    }
    dirty.delete(id);
  }
  function put(row: records.Row) {
    const previous = rows.get(records.identity(row));
    if (previous) {
      index(previous, true);
    }
    rows.set(records.identity(row), row);
    index(row);
  }
  function acquireEntry(row: records.Row, storedEntry: SessionEntry | undefined) {
    if (!storedEntry || storedEntry.incognito) {
      remove(records.identity(row));
      return undefined;
    }
    const entry = projectGatewaySessionEntry(cfg, storedEntry);
    const parents = new Set(
      [
        storedEntry.parentSessionKey ?? resolveSessionParentSessionKey(row.key),
        storedEntry.spawnedBy,
        ...(context.subagentRunsByChildSessionKey.get(row.key) ?? []).map(
          (run) => run.controllerSessionKey || run.requesterSessionKey,
        ),
      ].flatMap((key) =>
        key && key !== row.key
          ? [parentReference(key, row.agentId, row.storeTarget.storePath)]
          : [],
      ),
    );
    const changed = !isDeepStrictEqual([storedEntry, parents], [row.storedEntry, row.parents]);
    if (changed) {
      related(row);
    }
    const generation =
      !row.entry ||
      (row.entry.sessionId === entry.sessionId &&
        row.entry.lifecycleRevision === entry.lifecycleRevision)
        ? row.generation
        : Symbol("row");
    const next = { ...row, storedEntry, entry, parents, generation };
    put(next);
    if (changed) {
      related(next);
    }
    return next;
  }
  function inScope(row: records.Row, query: records.Query) {
    return (
      (!query.agentId ||
        row.agentId === query.agentId ||
        row.storeTarget.agentId === query.agentId) &&
      (!query.storePath ||
        (scope?.physicalPaths(query.storePath, query.agentId) ?? [query.storePath]).includes(
          row.storeTarget.storePath,
        ))
    );
  }
  function matching(query: records.Query, kind = "key") {
    const candidates = query.key
      ? byKey.get(`${kind}:${query.key}`)
      : query.storePath
        ? new Set(
            (scope?.physicalPaths(query.storePath, query.agentId) ?? [query.storePath]).flatMap(
              (path) => Array.from(byStore.get(path) ?? []),
            ),
          )
        : query.agentId
          ? byAgent.get(query.agentId)
          : rows.keys();
    return [...(candidates ?? [])]
      .map((id) => rows.get(id))
      .filter((row): row is records.Row => row !== undefined && inScope(row, query));
  }
  function lookup(query: records.Lookup) {
    if (disposed) {
      return undefined;
    }
    const { agentId } = query;
    const exact = matching(query).filter((row) => row.agentId === agentId);
    if (exact.length) {
      return records.first(exact, stores.keys());
    }
    const key = resolveStoredSessionKeyForAgentStore({
      cfg,
      sessionKey: query.key,
      agentId,
    });
    if (isIncognitoSessionKey(key)) {
      const ephemeralPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
      if (!listOpenIncognitoAgentDatabases().some((store) => store.storePath === ephemeralPath)) {
        return undefined;
      }
      const row = records.create({
        key,
        agentId,
        storeTarget: { agentId, storePath: ephemeralPath },
      });
      const storedEntry = readEntry(row);
      return storedEntry
        ? Object.assign(row, { storedEntry, entry: projectGatewaySessionEntry(cfg, storedEntry) })
        : undefined;
    }
    const candidates = matching({ ...query, key }).filter((row) => row.agentId === agentId);
    return records.first(candidates, stores.keys());
  }
  function referenced(ref: string) {
    return records.first(
      [...(byKey.get(ref) ?? [])].flatMap((id) => rows.get(id) ?? []),
      stores.keys(),
    );
  }
  function parentReference(key: string, fallbackAgentId: string, sourcePath?: string) {
    if (sourcePath && (key === "global" || key === "unknown")) {
      return records.physical(sourcePath, key);
    }
    const agentId = parseAgentSessionKey(key)?.agentId ?? fallbackAgentId;
    return records.logical(
      agentId,
      resolveStoredSessionKeyForAgentStore({ cfg, agentId, sessionKey: key }),
    );
  }
  function topology() {
    const revision = epoch;
    cfg = params.getConfig?.() ?? cfg;
    const admitted = new Set<string>();
    const nextStores: typeof stores = new Map();
    const replaced = new Set<string>();
    const loaded = loadCombinedSessionStoreForGatewayCore(cfg, {
      includeIncognito: false,
      preserveSentinelOwners: "physical",
      loadEntries(target, projection) {
        const opened = withOpenClawAgentDatabaseReadOnly(readOpenClawAgentDatabaseIdentity, {
          agentId: target.agentId,
          path: target.storePath,
        });
        if (!opened.found) {
          return [];
        }
        const databaseIdentity = opened.value.identity;
        const previous =
          stores.get(target.storePath) ??
          [...stores.values()].find((source) => source.identity === databaseIdentity);
        nextStores.set(target.storePath, {
          target,
          agentId: previous?.agentId ?? target.agentId,
          identity: databaseIdentity,
          filename: opened.value.filename,
        });
        if (previous?.identity === databaseIdentity) {
          return matching({ storePath: previous.target.storePath }).flatMap((row) => {
            const entry = row.storedEntry ?? readEntry(row);
            return entry ? [{ sessionKey: row.key, entry }] : [];
          });
        }
        replaced.add(target.storePath);
        return listSessionEntriesReadOnly({ ...target, projection, clone: false });
      },
      onStoreLoaded(target, agentId) {
        const source = nextStores.get(target.storePath);
        if (source) {
          source.agentId = agentId;
        }
      },
    });
    for (const [key, target] of loaded.targetsBySessionKey) {
      const entry = target.entry;
      if (!entry || entry.incognito || isIncognitoSessionKey(key)) {
        continue;
      }
      const fields = {
        key: target.storeKey ?? key,
        agentId: target.agentId,
        storeTarget: target.storeTarget,
      };
      const id = records.identity(fields);
      admitted.add(id);
      if (!rows.has(id) || replaced.has(target.storeTarget.storePath)) {
        if (replaced.has(target.storeTarget.storePath) && isAcpSessionKey(fields.key)) {
          // Retain partial ACP-key migration at physical admission, never on a clean read.
          resolveDeletedAgentIdFromSessionKey(cfg, fields.key, entry, {
            acpMetadataSessionKey: fields.key,
          });
        }
        remove(id);
        put(records.create(fields, entry));
        dirty.add(id);
      }
    }
    for (const id of rows.keys()) {
      if (!admitted.has(id)) {
        remove(id);
      }
    }
    stores = nextStores;
    scope = prepareSessionRowScopes(
      cfg,
      byAgent.keys(),
      new Map([...stores].map(([locator, source]) => [source.filename, locator])),
    );
    topologyDirty = epoch !== revision;
  }
  function mark(change: SessionRowChange) {
    epoch++;
    if ("all" in change) {
      if (change.scope === "profiles") {
        context.userProfileIdentityById.clear();
      }
      topologyDirty ||= change.scope === "stores" || change.scope === "config";
      if (params.getModelCatalog && (change.scope === "catalog" || change.scope === "config")) {
        catalogDirty = Symbol("catalog");
      }
      for (const row of typeof change.scope === "string" ? rows.values() : matching(change.scope)) {
        dirty.add(records.identity(row));
      }
    } else {
      const query = { ...change, key: change.sessionKey };
      const exact = matching(query);
      const found = new Set([...exact, ...matching(query, "id")]);
      for (const row of found) {
        dirty.add(records.identity(row));
        related(row);
      }
      if (
        !exact.length &&
        !isInternalSessionEffectsKey(change.sessionKey) &&
        !isIncognitoSessionKey(change.sessionKey)
      ) {
        for (const source of stores.values()) {
          const agentId = parseAgentSessionKey(change.sessionKey)?.agentId ?? source.agentId;
          const row = records.create({
            key: change.sessionKey,
            agentId,
            storeTarget: source.target,
          });
          if (!inScope(row, change) || (!change.storePath && agentId !== source.agentId)) {
            continue;
          }
          put(row);
          dirty.add(records.identity(row));
        }
      }
    }
    void ensureMaterialized().catch(() => {
      /* Dirty keys retain failed background work for the next reader. */
    });
  }
  function prepare() {
    if (preparedEpoch === epoch) {
      return;
    }
    context = buildSessionListRowMetadataContext({
      now: Date.now(),
      subagentRuns: buildSubagentSessionListReadIndex(),
      userProfileIdentityById: context.userProfileIdentityById,
    });
    context.projectedAgentRuns = buildProjectedAgentRunIndex();
    Object.assign(subagentInputs, context.subagentRuns.inputs);
    preparedEpoch = epoch;
  }
  function readEntry(row: records.Row) {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        if (isIncognitoSessionKey(row.key)) {
          row.generation = readOpenClawAgentDatabaseIdentity(database).identity;
        }
        const cache = readCommittedSessionEntryCache(database.db);
        return cache
          ? cache.get(row.key)
          : readExactSessionEntryRow(database, row.key, "list")?.entry;
      },
      { agentId: row.storeTarget.agentId, path: row.storeTarget.storePath },
    );
    return result.found ? result.value : undefined;
  }
  function materialize(row: records.Row, configuredAgentIds = new Set(listAgentIds(cfg))) {
    if (!row.entry) {
      return false;
    }
    const source = isIncognitoSessionKey(row.key)
      ? resolveGatewaySessionStoreTargetWithStore({
          cfg,
          key: row.key,
          agentId: row.agentId,
          exactRead: true,
          projection: "list",
          includeStoreChildEntries: true,
        })
      : undefined;
    const links = [...dependents(row)].flatMap((child) => {
      const value = rows.get(child);
      return value?.entry && [...value.parents].some((ref) => referenced(ref) === row)
        ? [{ key: value.key, entry: value.entry }]
        : [];
    });
    const { inputs, presentation } = readSessionRowInputs({
      ...row,
      cfg,
      configuredAgentIds,
      store: source?.store ?? {},
      storePath: row.storeTarget.storePath,
      storeAgentId: row.storeTarget.agentId,
      active: false,
      modelCatalog,
      modelSource: {
        entry: row.storedEntry,
        readSourceEntry: source
          ? createGatewaySessionEntryReader({ cfg, ...source })
          : (key) =>
              referenced(parentReference(key, row.agentId, row.storeTarget.storePath))?.storedEntry,
      },
      rowContext: context,
      includeDerivedTitles: true,
      includeLastMessage: true,
      includeSwarmChildren: true,
      transcriptUsageMaxBytes: 64 * 1024,
      storeChildSessionLinksByKey: source ? undefined : new Map([[row.key, links]]),
    });
    inputs.subagentRunInputs = subagentInputs;
    const facts = readSessionRowFacts({
      cfg,
      target: row,
      entry: row.entry,
      context: params.context,
    });
    const membership = new Set(
      listSessionMembers({ ...row.storeTarget, sessionKey: row.key }).map(
        (member) => member.identityId,
      ),
    );
    if (!source && rows.get(records.identity(row)) !== row) {
      return false;
    }
    Object.assign(row, {
      materialized: materializeSessionRow(inputs),
      materializedSequence: ++materializedCount,
      fallbackModel: presentation.activeModel,
      facts,
      membership,
    });
    return true;
  }
  function refresh(ids: readonly string[]) {
    if (disposed) {
      return;
    }
    const started = performance.now();
    prepare();
    const configuredAgentIds = new Set(listAgentIds(cfg));
    for (const id of ids) {
      const row = rows.get(id);
      if (row) {
        acquireEntry(row, readEntry(row));
      }
    }
    for (const [offset, id] of ids.entries()) {
      if (offset > 0 && performance.now() - started >= 12) {
        break;
      }
      const row = rows.get(id),
        revision = epoch;
      if (row && materialize(row, configuredAgentIds) && epoch === revision) {
        dirty.delete(id);
      }
    }
  }
  async function drain() {
    while (topologyDirty || catalogDirty || dirty.size) {
      if (disposed) {
        return;
      }
      if (topologyDirty) {
        topology();
      }
      if (catalogDirty) {
        const revision = catalogDirty;
        const next = await params.getModelCatalog?.();
        if (catalogDirty !== revision) {
          continue;
        }
        modelCatalog = next;
        catalogDirty = undefined;
      }
      withAgentRosterFactsBatch(cfg, () => refresh([...dirty].slice(0, 64)));
      if (dirty.size || topologyDirty) {
        await yieldSessionListWork();
      }
    }
  }
  function ensureMaterialized(): Promise<void> {
    if (disposed || (!topologyDirty && !catalogDirty && !dirty.size)) {
      return pending ?? Promise.resolve();
    }
    return (pending ??= yieldSessionListWork()
      .then(() => inOwnerContext(drain))
      .then(
        () => {
          pending = undefined;
          if (!disposed && (topologyDirty || catalogDirty || dirty.size)) {
            return ensureMaterialized();
          }
          return undefined;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      ));
  }
  const stop = [
    retainUserProfileCatalog(),
    sessionChanges.subscribe(mark),
    onSessionLifecycleEvent(mark),
    registerPreparedModelRuntimePublicationListener(() => mark({ all: true, scope: "catalog" })),
    onInternalSessionTranscriptUpdate((update) => {
      if (update.target) {
        mark(update.target);
      }
    }),
    onSessionIdentityMutation((mutation) => {
      for (const key of mutation.previous.sessionKeys) {
        for (const row of matching({ key, agentId: mutation.agentId })) {
          if (mutation.previous.sessionId && row.entry?.sessionId !== mutation.previous.sessionId) {
            continue;
          }
          related(row);
          if ("current" in mutation && mutation.current.sessionKeys.includes(row.key)) {
            put({
              ...row,
              entry: undefined,
              storedEntry: undefined,
              materialized: undefined,
              generation: Symbol("row"),
            });
            dirty.add(records.identity(row));
          } else {
            remove(records.identity(row));
          }
        }
      }
      if ("current" in mutation) {
        for (const sessionKey of mutation.current.sessionKeys) {
          mark({ agentId: mutation.agentId, sessionKey });
        }
      } else {
        void ensureMaterialized().catch(() => {});
      }
    }),
  ];
  function isCurrent(row: records.Row) {
    const current = isIncognitoSessionKey(row.key)
      ? lookup({ ...row, storePath: row.storeTarget.storePath })
      : rows.get(records.identity(row));
    return (
      current?.generation === row.generation &&
      (!isIncognitoSessionKey(row.key) ||
        (current.entry?.sessionId === row.entry?.sessionId &&
          current.entry?.lifecycleRevision === row.entry?.lifecycleRevision))
    );
  }
  const describe = (query: records.Lookup, captured?: records.Row) => {
    if (captured && !isCurrent(captured)) {
      return undefined;
    }
    const row = lookup(query);
    if (topologyDirty || catalogDirty || (row && dirty.has(records.identity(row)))) {
      throw new Error("Await session projection materialization before reading a snapshot");
    }
    if (row && isIncognitoSessionKey(row.key)) {
      prepare();
      materialize(row);
    }
    return records.ready(row) ? row : undefined;
  };
  function dispose() {
    disposed = true;
    for (const unsubscribe of stop) {
      unsubscribe();
    }
    for (const map of [rows, stores, byStore, byAgent, byParent, byKey]) {
      map.clear();
    }
    dirty.clear();
  }
  const present = (
    record: NonNullable<ReturnType<typeof describe>>,
    options: records.SnapshotOptions = {},
  ) => records.present(record, context, options);
  await ensureMaterialized().catch((error: unknown) => {
    dispose();
    throw error;
  });
  return {
    capture(query: records.Lookup) {
      if (!disposed && topologyDirty) {
        inOwnerContext(topology);
      }
      const row = lookup(query);
      return row && dirty.has(records.identity(row))
        ? (acquireEntry(row, readEntry(row)) ?? row)
        : row;
    },
    findBySessionId(query: { sessionId: string; agentId?: string; storePath?: string }) {
      if (
        !query.agentId ||
        !query.storePath ||
        !isIncognitoOpenClawAgentSqlitePath(query.storePath, { agentId: query.agentId })
      ) {
        return matching({ ...query, key: query.sessionId }, "id");
      }
      const key = !disposed && resolveSessionKeyBySessionId(query);
      const row = key ? lookup({ ...query, agentId: query.agentId, key }) : undefined;
      return row?.entry?.sessionId === query.sessionId ? [row] : [];
    },
    describe,
    present,
    ensureMaterialized,
    get materializedCount() {
      return materializedCount;
    },
    get dirtyRowCount() {
      return dirty.size;
    },
    get needsMaterialization() {
      return !disposed && (topologyDirty || Boolean(catalogDirty) || dirty.size > 0);
    },
    get state() {
      return { cfg, modelCatalog, rowContext: context, scope: scope.select };
    },
    isCurrent,
    select(query: records.Query = {}) {
      const parent = query.parentSessionKey;
      const owner = parent && parseAgentSessionKey(parent)?.agentId;
      const agents = owner ? [owner] : query.agentId ? [query.agentId] : byAgent.keys();
      const children = new Set<string>();
      if (parent) {
        for (const ref of [
          ...[...agents].map((agentId) => parentReference(parent, agentId)),
          ...matching({ ...query, key: parent }).map((row) =>
            records.physical(row.storeTarget.storePath, parent),
          ),
        ]) {
          for (const id of byParent.get(ref) ?? []) {
            children.add(id);
          }
        }
      }
      const candidates = parent ? [...children].map((id) => rows.get(id)) : matching(query);
      return candidates
        .filter(records.ready)
        .filter((row) => inScope(row, query) && (!query.agentId || row.agentId === query.agentId))
        .toSorted((a, b) =>
          compareSessionEntryPairs([a.key, a.entry], [b.key, b.entry], query.sortBy),
        );
    },
    snapshot(query: records.Lookup, options: records.SnapshotOptions = {}) {
      const record = describe(query);
      return record
        ? { row: present(record, options), lifecycleRunId: record.entry.lifecycleRunId }
        : { row: null };
    },
    dispose,
  };
}

export type SessionRowProjection = Awaited<ReturnType<typeof createSessionRowProjection>>;
