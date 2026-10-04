import {
  mergeCombinedSessionStore,
  prepareCombinedSessionStore,
} from "../config/sessions/combined-store-gateway.js";
import type { GatewaySessionStoreDiscovery } from "../config/sessions/combined-store-paths.js";
import type { SessionEntrySummary } from "../config/sessions/session-accessor.types.js";
import { projectionLane } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import type { createSessionMembershipProjection } from "./session-membership-projection.js";
import { withReadySessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { readSessionRowEntry as readStoredSessionRowEntry } from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";

/** Inodes can be reused after deletion; aliases share only the same file generation. */
function findStoreGeneration(
  stores: ReadonlyMap<string, records.SessionRowStore>,
  storePath: string,
  database: Pick<records.SessionRowStore, "identity" | "birthtime">,
): records.SessionRowStore | undefined {
  const matches = (store: records.SessionRowStore) =>
    store.identity === database.identity && store.birthtime === database.birthtime;
  const previous = stores.get(storePath);
  return previous && matches(previous) ? previous : [...stores.values()].find(matches);
}

/** Reconciliation outlives display residency; exact reads consume bounded, fixed key batches. */
export function createSessionRowFactsReadiness(
  rows: ReadonlyMap<string, records.Row>,
  owner: () => Parameters<typeof withReadySessionRows>[0],
) {
  const categories = new Set<string>();
  const structural = new Map<string, Set<string>>();
  function track(row: records.Row, domain: records.Row["unresolvedDatabaseFacts"]) {
    const id = records.identity(row);
    if (domain === "category") {
      categories.add(id);
    } else {
      categories.delete(id);
    }
    const path = row.storeTarget.storePath;
    let current = structural.get(path);
    if (domain === true) {
      current ??= new Set<string>();
      current.add(id);
      structural.set(path, current);
    } else if (current?.delete(id) && current.size === 0) {
      structural.delete(path);
    }
  }
  return {
    track,
    invalidate(row: records.Row, domain: true | "category") {
      // A category-only publication cannot downgrade unresolved structural facts.
      const next = row.unresolvedDatabaseFacts === true ? true : domain;
      row.unresolvedDatabaseFacts = next;
      if (rows.has(records.identity(row))) {
        track(row, next);
      }
      return next === "category";
    },
    conservativeChange(
      change: SessionRowChange,
      physicalPaths: (path: string) => readonly string[],
    ) {
      if (
        !("all" in change) &&
        change.factsInvalidated === "category" &&
        structural.size > 0 &&
        (!change.storePath || physicalPaths(change.storePath).some((path) => structural.has(path)))
      ) {
        return {
          all: true,
          scope: { storePath: change.storePath },
          factsInvalidated: true,
        } as const;
      }
      return change;
    },
    needsPreparation: () => categories.size > 0,
    async prepare(this: void) {
      const queries: records.Lookup[] = [];
      for (const id of categories) {
        const row = rows.get(id)!;
        queries.push({ agentId: row.agentId, key: row.key, storePath: row.storeTarget.storePath });
        if (queries.length === MAX_SESSION_ROW_FACTS_KEYS) {
          break;
        }
      }
      if (queries.length > 0) {
        await withReadySessionRows(
          owner(),
          () => queries,
          () => undefined,
        );
      }
    },
    clear() {
      categories.clear();
      structural.clear();
    },
  };
}

/** Readiness and synchronous sharing selection share the resident row owner's lifetime. */
export function createSessionRowMembershipReadAccess(params: {
  membership: ReturnType<typeof createSessionMembershipProjection>;
  runInOwner: <T>(read: () => T) => T;
  isActive: () => boolean;
  topologyDirty: () => boolean;
  topology: () => Promise<void>;
  lookup: (query: records.Lookup) => records.Row | undefined;
  stores: () => ReadonlyMap<string, records.SessionRowStore>;
  owner: () => SessionRowReadView & { isCurrent(row: records.Row): boolean };
  needsRowFactsPreparation: () => boolean;
  prepareRowFacts: () => Promise<void>;
}) {
  const { membership } = params;
  const needsMembershipFactsPreparation = () =>
    params.isActive() && (params.topologyDirty() || membership.needsPreparation);
  const needsMembershipPreparation = () =>
    needsMembershipFactsPreparation() || (params.isActive() && params.needsRowFactsPreparation());
  async function prepareMembershipFacts() {
    do {
      if (params.isActive() && params.topologyDirty()) {
        await params.runInOwner(params.topology);
      }
      if (!params.isActive()) {
        return;
      }
      if (params.topologyDirty()) {
        continue;
      }
      await params.runInOwner(() => membership.prepare());
    } while (needsMembershipFactsPreparation());
  }
  const sharingTarget = (query: records.Lookup) => {
    if (!params.isActive() || params.topologyDirty() || isIncognitoSessionKey(query.key)) {
      return null;
    }
    const row = params.lookup(query);
    const entry = row?.sharingEntry;
    return row && entry
      ? {
          agentId: row.agentId,
          generation: row.generation,
          canonicalKey: row.key,
          entry,
          storeKey: row.key,
          storeKeys: [row.key],
          storePath: row.storeTarget.storePath,
        }
      : null;
  };
  return {
    readMembership(query: records.Lookup) {
      if (!params.isActive()) {
        return undefined;
      }
      const row = params.lookup(query);
      if (row && isIncognitoSessionKey(row.key)) {
        return params.owner().describe(query)?.membership;
      }
      const members = row && membership.membership(row.storeTarget.storePath, row.key);
      return members ? new Set(members) : undefined;
    },
    readSource(target: records.Row | records.Lookup) {
      const row = "storeTarget" in target ? target : params.lookup(target);
      if (!row) {
        throw new Error("Session store changed while preparing authorization");
      }
      const source = params.stores().get(row.storeTarget.storePath);
      // Incognito rows retain their process-local locator and native lifetime guard.
      if (!source && isIncognitoSessionKey(row.key)) {
        return undefined;
      }
      if (!source || !params.owner().isCurrent(row)) {
        throw new Error("Session store changed while preparing authorization");
      }
      return {
        agentId: source.target.agentId,
        path: source.filename,
        databaseIdentity: source.identity,
        databaseBirthtime: source.birthtime,
      };
    },
    prepareMembershipFacts,
    async prepareMembership() {
      do {
        await prepareMembershipFacts();
        if (!params.isActive()) {
          return;
        }
        await params.runInOwner(params.prepareRowFacts);
      } while (needsMembershipPreparation());
    },
    needsMembershipPreparation,
    sessionGroupTargets() {
      if (!params.isActive() || params.topologyDirty() || membership.needsPreparation) {
        throw new Error("Session group membership changed; prepare current facts before reading");
      }
      return membership.groupTargets();
    },
    sharingTarget,
    /** Refresh uncertainty fences effects but does not retire a shared session resource. */
    sharingTargetState(query: records.Lookup) {
      if (!params.isActive() || isIncognitoSessionKey(query.key)) {
        return { status: "missing" as const };
      }
      if (params.topologyDirty()) {
        return { status: "pending" as const };
      }
      const target = sharingTarget(query);
      if (!target) {
        return { status: "missing" as const };
      }
      if (
        params.lookup(query)?.unresolvedDatabaseFacts === "category" ||
        !membership.ready(target.storePath, target.storeKey)
      ) {
        return { status: "pending" as const };
      }
      return { status: "ready" as const, target };
    },
    hasMembership: (storePath: string, key: string, identity: string) =>
      membership.membership(storePath, key)?.includes(identity) ?? false,
    needsExactMembershipPreparation(
      this: void,
      queries: (config: OpenClawConfig) => readonly records.Lookup[],
    ) {
      if (params.topologyDirty()) {
        return true;
      }
      if (!membership.needsPreparation) {
        return false;
      }
      return queries(params.owner().state.cfg).some((query) => {
        if (isIncognitoSessionKey(query.key)) {
          return false;
        }
        const row = params.lookup(query);
        return row !== undefined && !membership.ready(row.storeTarget.storePath, row.key);
      });
    },
  };
}

/** Replacements retire their grants before new committed sharing metadata becomes visible. */
export function createSessionRowEntryReadAccess(
  membership: ReturnType<typeof createSessionMembershipProjection>,
) {
  const invalidateRowMembership = (row: records.Row) => {
    if (!membership.matchesSession(row.storeTarget.storePath, row.key, undefined)) {
      membership.invalidate({
        agentId: row.agentId,
        storePath: row.storeTarget.storePath,
        sessionKey: row.key,
        factsInvalidated: true,
      });
    }
    row.membership = new Set();
  };
  const readSessionRowEntry = (row: records.Row) => {
    if (row.publishedSource && row.storedEntry && row.sharingEntry === row.storedEntry) {
      return row.storedEntry;
    }
    const entry = membership.withPreparedParticipantRead(() => readStoredSessionRowEntry(row));
    if (
      row.storedEntry &&
      row.storedEntry.sessionId !== entry?.sessionId &&
      !membership.matchesSession(row.storeTarget.storePath, row.key, entry?.sessionId)
    ) {
      invalidateRowMembership(row);
    }
    return entry;
  };
  return {
    invalidateRowMembership,
    readSessionRowEntry,
    createStoreRead: (params: {
      stores: ReadonlyMap<string, records.SessionRowStore>;
      rows: ReadonlyMap<string, records.Row>;
      byStore: ReadonlyMap<string, ReadonlySet<string>>;
      env?: NodeJS.ProcessEnv;
    }) => {
      const { stores, rows, byStore } = params;
      const sources = new Map<string, records.SessionRowStore>();
      const replaced = new Set<string>();
      const read = {
        sources,
        replaced,
        async loadCombinedStore<T>(
          cfg: OpenClawConfig,
          discovery: GatewaySessionStoreDiscovery,
          consume: (load: () => ReturnType<typeof mergeCombinedSessionStore>) => T,
        ): Promise<T> {
          const options = {
            discovery,
            includeIncognito: false,
            preserveSentinelOwners: "physical" as const,
          };
          const preparedStore = prepareCombinedSessionStore(cfg, options);
          // Pin every physical source before the first worker request yields.
          const captures = preparedStore.reads.flatMap(({ storeTarget: physical }) => {
            const file = readDatabasePathIdentitySync(physical.storePath);
            if (!file.key.startsWith("file:")) {
              return [];
            }
            const identity = file.key.slice("file:".length);
            return [
              {
                target: physical,
                file,
                previous: findStoreGeneration(stores, physical.storePath, {
                  identity,
                  birthtime: file.birthtime,
                }),
              },
            ];
          });
          return await withSessionHistoryWorkerDatabases(
            captures.map(({ target, file }) => ({
              agentId: target.agentId,
              path: file.canonicalPath,
              requestedPath: target.storePath,
              env: params.env,
            })),
            async (owners) => {
              const entries = new Map<string, SessionEntrySummary[]>();
              for (const [index, { target, file, previous }] of captures.entries()) {
                const prepared = previous
                  ? undefined
                  : await owners[index]!.readStoreProjection({
                      env: { ...(params.env ?? process.env) },
                      expectedIdentity: file,
                    });
                const source = previous ?? prepared?.source;
                if (!source) {
                  continue;
                }
                sources.set(target.storePath, {
                  target,
                  agentId: previous?.agentId ?? target.agentId,
                  discoveryAgentId: null,
                  identity: source.identity,
                  birthtime: source.birthtime,
                  filename: source.filename,
                });
                if (prepared) {
                  replaced.add(target.storePath);
                  entries.set(target.storePath, prepared.entries);
                }
              }
              for (const [index, { target, file }] of captures.entries()) {
                owners[index]!.assertCurrent();
                assertExistingDatabaseIdentity(target.storePath, file.key, file.birthtime);
              }
              return consume(() =>
                mergeCombinedSessionStore(
                  cfg,
                  {
                    ...options,
                    onStoreLoaded(target, agentId, owner) {
                      const source = sources.get(target.storePath);
                      if (source) {
                        source.agentId = agentId;
                        source.discoveryAgentId = owner?.agentId ?? null;
                        source.discoveryOrder = owner?.order;
                      }
                    },
                  },
                  preparedStore,
                  (target) => {
                    const previous = captures.find(
                      (capture) => capture.target.storePath === target.storePath,
                    )?.previous;
                    if (previous) {
                      return [...(byStore.get(previous.target.storePath) ?? [])].flatMap((id) => {
                        const row = rows.get(id);
                        const entry = row && (row.storedEntry ?? readSessionRowEntry(row));
                        return row && entry ? [{ sessionKey: row.key, entry }] : [];
                      });
                    }
                    return entries.get(target.storePath) ?? [];
                  },
                ),
              );
            },
            projectionLane,
          );
        },
        updateMembership() {
          membership.updateTargets(
            [...sources.values()].map((source) => ({
              agentId: source.target.agentId,
              storePath: source.target.storePath,
              discoveryAgentId: source.discoveryAgentId,
              discoveryOrder: source.discoveryOrder,
              identity: source.identity,
              birthtime: source.birthtime,
              filename: source.filename,
            })),
          );
        },
      };
      return read;
    },
  };
}
