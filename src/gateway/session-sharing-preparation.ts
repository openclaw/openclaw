import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  readCommittedIncognitoSessionSharing,
  retainPreparedSessionSharingFacts,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { assertSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { getOpenIncognitoAgentDatabase } from "../state/openclaw-agent-db-lifecycle.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../state/openclaw-agent-db-registry-listing.js";
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
    mainKey: cfg.session?.mainKey,
    scope: cfg.session?.scope,
  };
}

type SessionFactsRequest = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
};
type SessionFactsRead<Facts extends PreparedSessionMutationFacts> = {
  readCurrent(this: void, cfg: OpenClawConfig): Facts;
  release(this: void): void;
};

/** Negative durable reads retain the same keyed publication and source guards as existing rows. */
export function prepareSessionMutationFacts(
  params: SessionFactsRequest & { allowMissing: true },
): Promise<SessionFactsRead<PreparedSessionMutationFacts>>;
export function prepareSessionMutationFacts(
  params: SessionFactsRequest,
): Promise<SessionFactsRead<ExistingSessionMutationFacts>>;
export async function prepareSessionMutationFacts(
  params: SessionFactsRequest & { allowMissing?: true },
): Promise<SessionFactsRead<PreparedSessionMutationFacts>> {
  const route = routeFacts(params.cfg);
  const { canonicalKey, agentId } = resolveSessionStoreIdentity(params);
  const releases: Array<() => void> = [];
  let active = true;
  let invalidated = false;
  let facts: PreparedSessionMutationFacts | undefined;
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
      const database = getOpenIncognitoAgentDatabase(agentId, storePath);
      if (!database) {
        throw new SessionMutationFactsUnavailableError();
      }
      const initial = readCommittedIncognitoSessionSharing(database.db, canonicalKey);
      if (!initial) {
        throw new SessionMutationFactsUnavailableError();
      }
      const { sessionId, lifecycleRevision } = initial.entry;
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
          !current ||
          current.entry.sessionId !== sessionId ||
          current.entry.lifecycleRevision !== lifecycleRevision
        ) {
          invalidate();
          throw new SessionMutationFactsUnavailableError();
        }
        return {
          target: {
            agentId,
            canonicalKey,
            storeKey: canonicalKey,
            storeKeys: [canonicalKey],
            storePath,
            entry: current.entry,
          },
          membership: current.membership,
        };
      };
      facts = readFacts();
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
      const selected = await withSessionHistoryWorkerReadCandidates(
        discoveryCandidates,
        async (discovery) => {
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
                  members.set(read.storePath, loaded.sharing);
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
        },
      );
      assertActive();
      const match = findCanonicalStoreMatch(selected.store, selected.storeKeys);
      const sharing = members.get(selected.storePath);
      if (!match) {
        if (!params.allowMissing) {
          throw new SessionMutationFactsUnavailableError();
        }
        facts = { target: null, membership: new Set() };
      } else {
        if (!sharing) {
          throw new SessionMutationFactsUnavailableError();
        }
        const target = {
          agentId: selected.agentId,
          canonicalKey: selected.canonicalKey,
          storePath: selected.storePath,
          storeKeys: selected.storeKeys,
          entry: projectSessionSharingEntry(match.entry),
          storeKey: match.key,
        };
        facts = {
          target,
          membership: new Set(
            sharing.members.find((member) => member.sessionKey === match.key)?.identityIds,
          ),
        };
        selectedPaths.add(path.resolve(selected.storePath));
        selectedPaths.add(path.resolve(sharing.source.path));
        const sourceCandidates = discoveryCandidates.filter((candidate) =>
          matchesAgentDatabaseReadCandidatePath(
            { ...candidate, path: candidate.physicalPath },
            sharing.source.path,
          ),
        );
        if (sourceCandidates.length === 0) {
          throw new SessionMutationFactsUnavailableError();
        }
        for (const candidate of sourceCandidates) {
          selectedPaths.add(path.resolve(candidate.path));
        }
        const retained = retainedReads.get(`${sharing.databaseIdentity}\0${target.storeKey}`);
        if (!retained) {
          throw new SessionMutationFactsUnavailableError();
        }
        readFacts = () => {
          const current = retained.readCurrent();
          if (!current?.entry) {
            throw new SessionMutationFactsUnavailableError();
          }
          return {
            target: { ...target, entry: current.entry },
            membership: current.membership,
          };
        };
      }
      assertSource = () => {
        assertRegistry?.();
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
        return readFacts();
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
