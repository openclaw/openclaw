import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import type { GatewaySessionStoreDiscovery } from "../config/sessions/combined-store-paths.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntryListScope } from "../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { createSessionMembershipProjection } from "./session-membership-projection.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { readSessionRowEntry as readStoredSessionRowEntry } from "./session-row-projection-materialize.js";
import type * as records from "./session-row-projection-record.js";

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
}) {
  const { membership } = params;
  const needsMembershipPreparation = () =>
    params.isActive() && (params.topologyDirty() || membership.needsPreparation);
  async function prepareMembership() {
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
    } while (needsMembershipPreparation());
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
    readSource(row: records.MaterializedRow) {
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
    prepareMembership,
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
      if (!membership.ready(target.storePath, target.storeKey)) {
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
        loadCombinedStore(
          cfg: OpenClawConfig,
          discovery: GatewaySessionStoreDiscovery,
        ): ReturnType<typeof loadCombinedSessionStoreForGatewayCore> {
          return loadCombinedSessionStoreForGatewayCore(cfg, {
            discovery,
            includeIncognito: false,
            preserveSentinelOwners: "physical",
            loadEntries: read.loadEntries,
            onStoreLoaded(target, agentId, owner) {
              const source = sources.get(target.storePath);
              if (source) {
                source.agentId = agentId;
                source.discoveryAgentId = owner?.agentId ?? null;
                source.discoveryOrder = owner?.order;
              }
            },
          });
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
        loadEntries: (
          target: records.Row["storeTarget"],
          projection: SessionEntryListScope["projection"],
        ) => {
          const opened = withOpenClawAgentDatabaseReadOnly(readOpenClawAgentDatabaseIdentity, {
            agentId: target.agentId,
            path: target.storePath,
            env: params.env,
          });
          if (!opened.found) {
            return [];
          }
          const previous = findStoreGeneration(stores, target.storePath, opened.value);
          sources.set(target.storePath, {
            target,
            agentId: previous?.agentId ?? target.agentId,
            discoveryAgentId: null,
            identity: opened.value.identity,
            birthtime: opened.value.birthtime,
            filename: opened.value.filename,
          });
          if (previous) {
            return [...(byStore.get(previous.target.storePath) ?? [])].flatMap((id) => {
              const row = rows.get(id);
              const entry = row && (row.storedEntry ?? readSessionRowEntry(row));
              return row && entry ? [{ sessionKey: row.key, entry }] : [];
            });
          }
          replaced.add(target.storePath);
          const entryScope = { ...target, projection, clone: false, env: params.env };
          return listSessionEntriesReadOnly(entryScope, { deferParticipants: true });
        },
      };
      return read;
    },
  };
}
