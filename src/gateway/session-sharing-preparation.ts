import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { projectSessionSharingEntry } from "../config/sessions/session-accessor.sqlite-entry-cache-projection.js";
import {
  isPreparedSessionSharingChange,
  readCommittedIncognitoSessionSharing,
  retainPreparedSessionSharingFacts,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolvePersistedSessionStoreOwner } from "../config/sessions/session-store-owner.js";
import { assertSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { getOpenIncognitoAgentDatabase } from "../state/openclaw-agent-db-lifecycle.js";
import {
  AgentDatabaseRegistryChangedError,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "../state/openclaw-agent-db-registry-listing.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../state/openclaw-agent-db-resources.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import {
  prepareGatewaySessionStoreTargetReadOnly,
  type GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";

type ExistingSessionMutationFacts = PreparedSessionMutationFacts & {
  target: NonNullable<PreparedSessionMutationFacts["target"]>;
};

type SessionFactsPreparation = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
};

type SessionFactsLocation = Pick<
  ExistingSessionMutationFacts["target"],
  "agentId" | "canonicalKey" | "storePath"
>;

type PreparedSessionFacts<T extends PreparedSessionMutationFacts> = {
  readCurrent(this: void, cfg: OpenClawConfig): T & { location: SessionFactsLocation };
  release(this: void): void;
};

export class SessionMutationFactsUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Session access facts are unavailable; retry after session storage is ready.", options);
    this.name = "SessionMutationFactsUnavailableError";
  }
}

function routeFacts(cfg: OpenClawConfig) {
  return {
    agents: listAgentIds(cfg),
    store: cfg.session?.store,
    storeOwner: resolvePersistedSessionStoreOwner(cfg),
    compatibilityOwner: tryResolveLegacyCompatibilityAgentId(cfg),
    mainKey: cfg.session?.mainKey,
    scope: cfg.session?.scope,
  };
}

export function prepareSessionMutationFacts(
  params: SessionFactsPreparation & { allowMissing: true },
): Promise<PreparedSessionFacts<PreparedSessionMutationFacts>>;
export function prepareSessionMutationFacts(
  params: SessionFactsPreparation & { allowMissing?: false },
): Promise<PreparedSessionFacts<ExistingSessionMutationFacts>>;
/** Retain session facts and negative lookups; committed writers own their current values. */
export async function prepareSessionMutationFacts(
  params: SessionFactsPreparation & { allowMissing?: boolean },
): Promise<PreparedSessionFacts<PreparedSessionMutationFacts>> {
  const route = routeFacts(params.cfg);
  const { canonicalKey, agentId } = resolveSessionStoreIdentity(params);
  const releases: Array<() => void> = [];
  let active = true;
  let invalidated = false;
  let facts: PreparedSessionMutationFacts | undefined;
  let location: SessionFactsLocation;
  const selectedPaths = new Set<string>();
  const release = () => {
    if (active) {
      active = false;
      for (const stop of releases.splice(0).toReversed()) {
        stop();
      }
    }
  };
  const assertActive = () => {
    if (!active || invalidated) {
      throw new SessionMutationFactsUnavailableError();
    }
  };
  const invalidate = () => {
    invalidated = true;
  };
  const changed = (change: SessionRowChange) => {
    if ("all" in change) {
      if (
        typeof change.scope === "string" &&
        [
          "profiles",
          "catalog",
          "acp",
          "agent-runs",
          "worker-placements",
          "worker-environments",
          "config",
        ].includes(change.scope)
      ) {
        return;
      }
      if (
        typeof change.scope === "object" &&
        change.scope.agentId &&
        change.scope.agentId !== agentId
      ) {
        return;
      }
      invalidate();
      return;
    }
    if (
      change.scope === "automation" ||
      (change.agentId && change.agentId !== agentId && !change.storePath) ||
      ![params.sessionKey, canonicalKey, ...(facts?.target?.storeKeys ?? [])].includes(
        change.sessionKey,
      )
    ) {
      return;
    }
    // Placement and presentation observers do not change stored sharing facts.
    // Entry/member writers name their physical store; identity changes have a separate owner.
    if (!change.storePath) {
      return;
    }
    if (
      !change.factsInvalidated &&
      (change.facts?.kind === "unchanged" ||
        change.facts?.kind === "participants" ||
        change.facts?.kind === "category")
    ) {
      return;
    }
    if (
      !facts ||
      !selectedPaths.has(path.resolve(change.storePath)) ||
      !isPreparedSessionSharingChange(change)
    ) {
      invalidate();
    }
  };
  releases.push(
    sessionChanges.subscribeFacts(changed),
    onSessionIdentityMutation((change) => {
      if (change.agentId === agentId && change.previous.sessionKeys.includes(canonicalKey)) {
        invalidate();
      }
    }),
  );
  try {
    let assertSource: () => void;
    let readFacts = () => facts!;
    if (isIncognitoSessionKey(canonicalKey)) {
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
      location = { agentId, canonicalKey, storePath };
      const database = getOpenIncognitoAgentDatabase(agentId, storePath);
      if (!database) {
        if (!params.allowMissing) {
          throw new SessionMutationFactsUnavailableError();
        }
        facts = { target: null, membership: new Set() };
        assertSource = () => {
          if (getOpenIncognitoAgentDatabase(agentId, storePath)) {
            throw new SessionMutationFactsUnavailableError();
          }
        };
      } else {
        const initial = readCommittedIncognitoSessionSharing(database.db, canonicalKey);
        if (!initial && !params.allowMissing) {
          throw new SessionMutationFactsUnavailableError();
        }
        const sessionId = initial?.entry.sessionId;
        const lifecycleRevision = initial?.entry.lifecycleRevision;
        selectedPaths.add(path.resolve(storePath));
        releases.push(
          registerOpenClawAgentDatabaseAsyncResource({
            agentId,
            path: storePath,
            revoke: release,
            close: async () => release(),
          }),
        );
        assertSource = () => {
          if (getOpenIncognitoAgentDatabase(agentId, storePath) !== database) {
            throw new SessionMutationFactsUnavailableError();
          }
        };
        readFacts = () => {
          const current = readCommittedIncognitoSessionSharing(database.db, canonicalKey);
          if (
            current?.entry.sessionId !== sessionId ||
            current?.entry.lifecycleRevision !== lifecycleRevision
          ) {
            invalidate();
            throw new SessionMutationFactsUnavailableError();
          }
          return {
            target: current
              ? {
                  agentId,
                  canonicalKey,
                  storeKey: canonicalKey,
                  storeKeys: [canonicalKey],
                  storePath,
                  entry: current.entry,
                }
              : null,
            membership: current?.membership ?? new Set(),
          };
        };
        facts = readFacts();
      }
    } else {
      const parsedAgent = parseAgentSessionKey(params.sessionKey)?.agentId;
      const { candidates: discoveryCandidates, ...inventory } = prepareSessionStoreTargetInventory(
        params.cfg,
        [agentId, ...(parsedAgent ? [parsedAgent] : [])],
      );
      const candidates = discoveryCandidates.flatMap((candidate) => [
        candidate,
        { ...candidate, path: candidate.physicalPath },
      ]);
      const candidateIdentities = discoveryCandidates.map((candidate) => ({
        candidate,
        identity: readDatabasePathIdentitySync(candidate.path).key,
      }));
      for (const candidate of candidates) {
        releases.push(
          registerOpenClawAgentDatabaseReadCandidateResource({
            ...candidate,
            revoke: release,
            close: async () => release(),
          }),
        );
      }
      const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: inventory.env });
      let assertRegistry: (() => void) | undefined;
      const members = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof readSessionEntriesFromStoreInWorker>>["sharing"]>
      >();
      const retainedReads = new Map<string, ReturnType<typeof retainPreparedSessionSharingFacts>>();
      const assertReadIdentities = () => {
        for (const { candidate, identity } of candidateIdentities) {
          assertSessionStoreReadCandidate(candidate.path, [candidate]);
          if (readDatabasePathIdentitySync(candidate.path).key !== identity) {
            throw new SessionMutationFactsUnavailableError();
          }
        }
        for (const read of members.values()) {
          if (readDatabasePathIdentitySync(read.source.path).key !== read.databaseIdentity) {
            throw new SessionMutationFactsUnavailableError();
          }
        }
        for (const read of retainedReads.values()) {
          if (!read.readCurrent()) {
            throw new SessionMutationFactsUnavailableError();
          }
        }
      };
      const assertPreparationCurrent = () => {
        assertActive();
        if (!isDeepStrictEqual(routeFacts(params.cfg), route)) {
          throw new SessionMutationFactsUnavailableError();
        }
        assertReadIdentities();
      };
      const select = () =>
        withSessionHistoryWorkerReadCandidates(discoveryCandidates, async (discovery) => {
          assertRegistry = undefined;
          let sources = await discovery.readTargetInventory({
            ...inventory,
            registeredDatabases: { status: "deferred" },
          });
          if (sources.kind === "session-target-registry-required") {
            const current = await registry.read();
            assertRegistry = current.assertCurrent;
            current.assertCurrent();
            sources = await discovery.readTargetInventory({
              ...inventory,
              registeredDatabases:
                current.result.status === "available"
                  ? current.result.entries
                  : { status: "unavailable" },
            });
          }
          if (sources.kind !== "session-target-inventory") {
            throw new SessionMutationFactsUnavailableError();
          }
          const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
          for (const source of sources.agents) {
            if (!source.result.available && source.result.reason !== "database-missing") {
              throw new SessionMutationFactsUnavailableError();
            }
            targetDiscoveryCache.set(source.agentId, {
              existing: source.result.available ? source.result.targets : [],
              fallback: {
                agentId: source.agentId,
                storePath: inventory.paths.get(source.agentId)!.configured,
              },
            });
          }
          const target = await prepareGatewaySessionStoreTargetReadOnly(
            {
              cfg: inventory.config,
              key: params.sessionKey,
              agentId,
              env: inventory.env,
              targetDiscoveryCache,
            },
            async (reads) => {
              for (const read of reads) {
                assertActive();
                const loaded = await readSessionEntriesFromStoreInWorker({
                  agentId: read.agentId ?? agentId,
                  storePath: read.storePath,
                  sessionKeys: read.options.exactKeys!,
                  projection: "sharing",
                  env: inventory.env,
                });
                const store = Object.fromEntries(
                  loaded.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
                );
                read.result = ok(store);
                if (loaded.sharing) {
                  read.readSource = loaded.sharing.source;
                  const previous = members.get(read.storePath);
                  if (
                    previous &&
                    (previous.databaseIdentity !== loaded.sharing.databaseIdentity ||
                      previous.source.agentId !== loaded.sharing.source.agentId ||
                      previous.source.path !== loaded.sharing.source.path)
                  ) {
                    throw new SessionMutationFactsUnavailableError();
                  }
                  if (!previous) {
                    members.set(read.storePath, loaded.sharing);
                  }
                  for (const sessionKey of read.options.exactKeys!) {
                    const key = `${loaded.sharing.databaseIdentity}\0${sessionKey}`;
                    if (retainedReads.has(key)) {
                      continue;
                    }
                    const entry = store[sessionKey];
                    const retained = retainPreparedSessionSharingFacts({
                      databaseIdentity: loaded.sharing.databaseIdentity,
                      sessionKey,
                      entry: entry ? projectSessionSharingEntry(entry) : undefined,
                      membership: new Set(
                        loaded.sharing.members.find((row) => row.sessionKey === sessionKey)
                          ?.identityIds,
                      ),
                    });
                    retainedReads.set(key, retained);
                    releases.push(retained.release);
                  }
                }
              }
            },
          );
          discovery.assertCurrent();
          assertRegistry?.();
          return target;
        });
      let selected: Awaited<ReturnType<typeof select>>;
      let registryRefreshed = false;
      let assertRegistrationCurrent: (() => void) | undefined;
      for (;;) {
        try {
          selected = await select();
          assertRegistrationCurrent?.();
          break;
        } catch (error) {
          // Only initial registry discovery can refresh. Original row and physical
          // witnesses remain installed while the failed read worker releases.
          assertPreparationCurrent();
          const settlement =
            error instanceof AgentDatabaseRegistryChangedError
              ? error.registrationSettlement
              : undefined;
          if (!settlement || registryRefreshed) {
            throw error;
          }
          settlement.assertCurrent();
          registryRefreshed = true;
          assertRegistrationCurrent = settlement.assertCurrent;
          await settlement.promise;
          assertPreparationCurrent();
          assertRegistrationCurrent();
        }
      }
      assertActive();
      location = {
        agentId: selected.agentId,
        canonicalKey: selected.canonicalKey,
        storePath: selected.storePath,
      };
      const match = findCanonicalStoreMatch(selected.store, selected.storeKeys);
      const sharing = members.get(selected.storePath);
      if ((!match && !params.allowMissing) || (match && !sharing)) {
        throw new SessionMutationFactsUnavailableError();
      }
      facts = {
        target: match
          ? {
              agentId: selected.agentId,
              canonicalKey: selected.canonicalKey,
              storePath: selected.storePath,
              storeKeys: selected.storeKeys,
              entry: projectSessionSharingEntry(match.entry),
              storeKey: match.key,
            }
          : null,
        membership: new Set(
          sharing?.members.find((member) => member.sessionKey === match?.key)?.identityIds,
        ),
      };
      selectedPaths.add(path.resolve(selected.storePath));
      if (sharing) {
        selectedPaths.add(path.resolve(sharing.source.path));
      }
      const sourceCandidates = discoveryCandidates.filter((candidate) =>
        matchesAgentDatabaseReadCandidatePath(
          { ...candidate, path: candidate.physicalPath },
          sharing?.source.path ??
            resolveUnsuffixedSqliteTargetFromSessionStorePath(selected.storePath).path,
        ),
      );
      if (sourceCandidates.length === 0) {
        throw new SessionMutationFactsUnavailableError();
      }
      for (const candidate of sourceCandidates) {
        selectedPaths.add(path.resolve(candidate.path));
      }
      const target = {
        agentId: selected.agentId,
        canonicalKey: selected.canonicalKey,
        storePath: selected.storePath,
        storeKeys: selected.storeKeys,
        storeKey: match?.key ?? selected.canonicalKey,
      };
      const retained = sharing
        ? retainedReads.get(`${sharing.databaseIdentity}\0${target.storeKey}`)
        : undefined;
      if (!retained && (match || !params.allowMissing)) {
        throw new SessionMutationFactsUnavailableError();
      }
      readFacts = () => {
        const current = retained?.readCurrent();
        if (!current?.entry && (match || !params.allowMissing)) {
          throw new SessionMutationFactsUnavailableError();
        }
        return {
          target: current?.entry ? { ...target, entry: current.entry } : null,
          membership: current?.membership ?? new Set(),
        };
      };
      assertSource = () => {
        assertRegistry?.();
        assertReadIdentities();
      };
    }
    const readCurrent = (cfg: OpenClawConfig) => {
      try {
        assertActive();
        if (!isDeepStrictEqual(routeFacts(cfg), route)) {
          throw new SessionMutationFactsUnavailableError();
        }
        const currentIdentity = resolveSessionStoreIdentity({ ...params, cfg });
        if (currentIdentity.agentId !== agentId || currentIdentity.canonicalKey !== canonicalKey) {
          throw new SessionMutationFactsUnavailableError();
        }
        assertSource();
        return { ...readFacts(), location };
      } catch (error) {
        throw error instanceof SessionMutationFactsUnavailableError
          ? error
          : new SessionMutationFactsUnavailableError({ cause: error });
      }
    };
    readCurrent(params.cfg);
    return { readCurrent, release };
  } catch (error) {
    release();
    throw error instanceof SessionMutationFactsUnavailableError
      ? error
      : new SessionMutationFactsUnavailableError({ cause: error });
  }
}
