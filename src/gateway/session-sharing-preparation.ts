import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  assertSessionEntryCreationPublication,
  isPreparedSessionSharingChange,
  readSessionEntryCreationTransition,
  type SessionEntryPlaceholder,
  projectSessionSharingEntry,
  readCommittedIncognitoSessionSharing,
  retainPreparedSessionSharingFacts,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { SessionEntryCreationOperation } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  isSessionStoreTopologyChange,
  sessionChanges,
  type SessionRowChange,
} from "../sessions/session-row-changes.js";
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
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

type PreparedSessionSourceFacts = PreparedSessionMutationFacts & {
  /** Physical source retained by the same read custody as the sharing facts. */
  sourcePath?: string;
};

type ExistingSessionMutationFacts = PreparedSessionSourceFacts & {
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

export function captureSessionMutationRouting(cfg: OpenClawConfig) {
  const route = routeFacts(cfg);
  return (current: OpenClawConfig) => {
    if (!isDeepStrictEqual(routeFacts(current), route)) {
      throw new SessionMutationFactsUnavailableError();
    }
  };
}

type SessionFactsRequest = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  storageReady?: Promise<void>;
};
export type SessionFactsRead<Facts extends PreparedSessionMutationFacts> = {
  readonly storageTarget: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey" | "storePath">;
  bindCreation(this: void, operation: SessionEntryCreationOperation): void;
  readCurrent(this: void, cfg: OpenClawConfig): Facts;
  release(this: void): void;
};

/** Negative reads retain the same keyed publication and source guards as existing rows. */
export function prepareSessionMutationFacts(
  params: SessionFactsRequest & { allowMissing: true },
): Promise<SessionFactsRead<PreparedSessionSourceFacts>>;
export function prepareSessionMutationFacts(
  params: SessionFactsRequest,
): Promise<SessionFactsRead<ExistingSessionMutationFacts>>;
export async function prepareSessionMutationFacts(
  params: SessionFactsRequest & { allowMissing?: true },
): Promise<SessionFactsRead<PreparedSessionSourceFacts>> {
  const assertRoutingCurrent = captureSessionMutationRouting(params.cfg);
  const { canonicalKey, agentId } = resolveSessionStoreIdentity(params);
  const incognito = isIncognitoSessionKey(canonicalKey);
  const releases: Array<() => void> = [];
  let active = true;
  let beforeDiscovery = params.storageReady !== undefined;
  let invalidated = false;
  let facts: PreparedSessionSourceFacts | undefined;
  let creation: SessionEntryCreationOperation | undefined;
  let expectedPlaceholder: SessionEntryPlaceholder | undefined;
  let assertSource: () => void;
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
      // RAM has its original handle/resource fence; durable discovery waits for writer promotion.
      if (isSessionStoreTopologyChange(change)) {
        if (!beforeDiscovery && !incognito) {
          invalidate();
        }
        return;
      }
      if (
        typeof change.scope === "string" &&
        [
          "profiles",
          "catalog",
          "acp",
          "agent-runs",
          "subagent-runs",
          "worker-placements",
          "worker-environments",
          "config",
          "config-presentation",
          "config-profiles",
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
      active &&
      !invalidated &&
      facts?.target === null &&
      creation &&
      selectedPaths.has(path.resolve(change.storePath))
    ) {
      const placeholder = readSessionEntryCreationTransition(change, creation);
      if (placeholder) {
        try {
          assertSource();
          expectedPlaceholder = placeholder;
          return;
        } catch {
          invalidate();
          return;
        }
      }
    }
    if (
      !facts ||
      facts.target === null ||
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
  if (params.storageReady) {
    try {
      await params.storageReady;
    } catch (error) {
      release();
      throw error;
    }
    beforeDiscovery = false;
  }
  try {
    assertActive();
    let storageTarget: SessionFactsRead<PreparedSessionMutationFacts>["storageTarget"];
    let readFacts = () => facts!;
    if (incognito) {
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
      storageTarget = Object.freeze({ agentId, canonicalKey, storePath });
      let database = getOpenIncognitoAgentDatabase(agentId, storePath);
      const initial = database && readCommittedIncognitoSessionSharing(database.db, canonicalKey);
      if (!initial?.entry && !params.allowMissing) {
        throw new SessionMutationFactsUnavailableError();
      }
      const sessionId = initial?.entry?.sessionId;
      const lifecycleRevision = initial?.entry?.lifecycleRevision;
      expectedPlaceholder = initial?.placeholder;
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
        const current = getOpenIncognitoAgentDatabase(agentId, storePath);
        // The original registered resource survives first namespace creation;
        // retirement revokes it before any replacement can be adopted.
        database ??= current;
        if (current !== database) {
          throw new SessionMutationFactsUnavailableError();
        }
      };
      readFacts = () => {
        const current = database && readCommittedIncognitoSessionSharing(database.db, canonicalKey);
        if (
          current?.entry?.sessionId !== sessionId ||
          current?.entry?.lifecycleRevision !== lifecycleRevision ||
          current?.placeholder !== expectedPlaceholder
        ) {
          invalidate();
          throw new SessionMutationFactsUnavailableError();
        }
        if (!current?.entry) {
          return { target: null, membership: new Set<string>() };
        }
        return {
          sourcePath: storePath,
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
            async (reads, select) => {
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
                      placeholder: loaded.sharing.placeholders.find(
                        (row) => row.sessionKey === sessionKey,
                      ),
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
              return select();
            },
          );
          discovery.assertCurrent();
          assertRegistry?.();
          return target;
        },
      );
      assertActive();
      storageTarget = Object.freeze({
        agentId: selected.agentId,
        canonicalKey: selected.canonicalKey,
        storePath: selected.storePath,
      });
      const match = findCanonicalStoreMatch(selected.store, selected.storeKeys);
      const sharing = members.get(selected.storePath);
      selectedPaths.add(path.resolve(selected.storePath));
      if (sharing) {
        selectedPaths.add(path.resolve(sharing.source.path));
      }
      if (!match) {
        if (!params.allowMissing) {
          throw new SessionMutationFactsUnavailableError();
        }
        facts = { target: null, membership: new Set() };
        const retained =
          sharing && retainedReads.get(`${sharing.databaseIdentity}\0${canonicalKey}`);
        expectedPlaceholder = retained?.readCurrent()?.placeholder;
        readFacts = () => {
          const current = retained?.readCurrent();
          if (
            (retained && !current) ||
            current?.entry ||
            current?.placeholder?.sessionId !== expectedPlaceholder?.sessionId
          ) {
            throw new SessionMutationFactsUnavailableError();
          }
          return { target: null, membership: new Set<string>() };
        };
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
          sourcePath: sharing.source.path,
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
            sourcePath: sharing.source.path,
            target: { ...target, entry: current.entry },
            membership: current.membership,
          };
        };
      }
      assertSource = () => {
        assertRegistry?.();
        for (const { candidate, identity } of candidateIdentities) {
          if (
            captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
              candidate.physicalPath ||
            readDatabasePathIdentitySync(candidate.path).key !== identity
          ) {
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
        assertRoutingCurrent(cfg);
        const currentIdentity = resolveSessionStoreIdentity({ ...params, cfg });
        if (currentIdentity.agentId !== agentId || currentIdentity.canonicalKey !== canonicalKey) {
          throw new SessionMutationFactsUnavailableError();
        }
        assertSource();
        if (creation) {
          assertSessionEntryCreationPublication(creation, {
            agentId,
            sessionKey: canonicalKey,
            paths: selectedPaths,
          });
        }
        return readFacts();
      } catch (error) {
        throw error instanceof SessionMutationFactsUnavailableError
          ? error
          : new SessionMutationFactsUnavailableError({ cause: error });
      }
    };
    readCurrent(params.cfg);
    const bindCreation = (operation: SessionEntryCreationOperation) => {
      readCurrent(params.cfg);
      if (creation && creation !== operation) {
        throw new SessionMutationFactsUnavailableError();
      }
      assertSessionEntryCreationPublication(operation, {
        agentId,
        sessionKey: canonicalKey,
        paths: selectedPaths,
      });
      creation = operation;
    };
    return { storageTarget, bindCreation, readCurrent, release };
  } catch (error) {
    release();
    throw error instanceof SessionMutationFactsUnavailableError
      ? error
      : new SessionMutationFactsUnavailableError({ cause: error });
  }
}
