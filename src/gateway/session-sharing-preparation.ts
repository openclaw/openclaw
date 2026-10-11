import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  resolveSessionStoreCompatibilityAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readPreparedSessionSharingChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import {
  assertSessionEntryCreationPublication,
  isPreparedSessionSharingChange,
  readSessionEntryCreationTransition,
  type SessionEntryPlaceholder,
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { SessionEntryCreationOperation } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import {
  createSessionStoreRegistryMutationFilter,
  prepareSessionStoreTargetInventory,
} from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  isSessionStoreTopologyChange,
  sessionChanges,
  type SessionRowChange,
} from "../sessions/session-row-changes.js";
import { isOpenClawAgentDatabaseRegistryChange } from "../state/openclaw-agent-db-registry-listing.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../state/openclaw-agent-db-resources.js";
import {
  captureSessionSharingMemoryFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-incognito.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import { prepareGatewaySessionStoreTargetReadOnly } from "./session-utils-store-lookup.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

type PreparedSessionSourceFacts = PreparedSessionMutationFacts & {
  /** Physical source retained by the same read custody as the sharing facts. */
  sourcePath?: string;
  sourceAgentId?: string;
};

type ExistingSessionMutationFacts = PreparedSessionSourceFacts & {
  target: NonNullable<PreparedSessionMutationFacts["target"]>;
};

export { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";

function routeFacts(cfg: OpenClawConfig) {
  return {
    agents: listAgentIds(cfg),
    storeOwner: resolveSessionStoreCompatibilityAgentId(cfg),
    compatibilityOwner: tryResolveLegacyCompatibilityAgentId(cfg),
    systemOwner: tryResolveAmbientOwnerAgentId(cfg),
    store: cfg.session?.store,
    mainKey: cfg.session?.mainKey,
    scope: cfg.session?.scope,
  };
}

export function captureSessionMutationRouting(
  cfg: OpenClawConfig,
  changed: () => Error = () => new SessionMutationFactsUnavailableError(),
) {
  const route = routeFacts(cfg);
  return (current: OpenClawConfig) => {
    if (!isDeepStrictEqual(routeFacts(current), route)) {
      throw changed();
    }
  };
}

type SessionFactsRequest = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  preserveQualifiedAddress?: boolean;
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
  let memoryActive = true;
  const memory = captureSessionSharingMemoryFacts(
    {
      agentId,
      sessionKey: canonicalKey,
      resolved: { storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }) },
    },
    () => {
      if (!memoryActive) {
        throw new SessionMutationFactsUnavailableError();
      }
    },
    Boolean(params.allowMissing),
  );
  if (memory) {
    const readCurrent = (cfg: OpenClawConfig) => {
      assertRoutingCurrent(cfg);
      return memory.readCurrent();
    };
    if (params.storageReady) {
      await params.storageReady;
    }
    readCurrent(params.cfg);
    return {
      storageTarget: { agentId, canonicalKey, storePath: memory.location.path },
      // The actor installs creation and its sharing facts together before acknowledgement.
      bindCreation() {},
      readCurrent,
      release() {
        memoryActive = false;
      },
    };
  }
  const initialStoreKeys = [params.sessionKey.trim(), canonicalKey];
  const releases: Array<() => void> = [];
  let active = true;
  let beforeDiscovery = params.storageReady !== undefined;
  let waitingForStorage = false;
  let invalidated = false;
  let facts: PreparedSessionSourceFacts | undefined;
  let assertRegistryPublication: (() => void) | undefined;
  let creation: SessionEntryCreationOperation | undefined;
  let expectedPlaceholder: SessionEntryPlaceholder | undefined;
  let assertSource: () => void;
  const selectedPaths = new Set<string>();
  let selectedDatabaseIdentity: string | undefined;
  const acquiringPaths = new Set<string>();
  const acquiringReads = new Map<string, ReturnType<typeof retainPreparedSessionSharingFacts>>();
  const initializedReads = new Set<string>();
  const acquireSource = (sourcePath: string, sessionKeys: readonly string[]) => {
    const identity = readDatabasePathIdentitySync(sourcePath);
    if (identity.birthtime === undefined) {
      return undefined;
    }
    acquiringPaths.add(path.resolve(sourcePath));
    acquiringPaths.add(identity.canonicalPath);
    for (const sessionKey of sessionKeys) {
      const key = `${identity.key}\0${sessionKey}`;
      if (!acquiringReads.has(key)) {
        const retained = retainPreparedSessionSharingFacts({
          databaseIdentity: identity.key,
          sessionKey,
          acquiring: true,
        });
        acquiringReads.set(key, retained);
        releases.push(retained.release);
      }
    }
    return identity;
  };
  const release = () => {
    if (active) {
      active = false;
      for (const stop of releases.splice(0).toReversed()) {
        stop();
      }
    }
  };
  const retainCandidate = (candidate: SessionStoreReadCandidate) => {
    for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
      releases.push(
        registerOpenClawAgentDatabaseReadCandidateResource({
          ...candidate,
          path: pathname,
          revoke: release,
          close: async () => release(),
        }),
      );
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
      if (isSessionStoreTopologyChange(change)) {
        if (beforeDiscovery) {
          return;
        }
        if (isOpenClawAgentDatabaseRegistryChange(change) && assertRegistryPublication) {
          try {
            assertRegistryPublication();
          } catch {
            invalidate();
          }
        } else {
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
      change.scope === "acp" ||
      (change.agentId && change.agentId !== agentId && !change.storePath) ||
      ![...initialStoreKeys, ...(facts?.target?.storeKeys ?? [])].includes(change.sessionKey)
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
    // A retained acquisition receives this exact source's postimage before this notification.
    // It still rejects replacements, unknown publications, and stale worker identities.
    if (
      !facts &&
      acquiringPaths.has(path.resolve(change.storePath)) &&
      isPreparedSessionSharingChange(change)
    ) {
      return;
    }
    if (
      !facts ||
      facts.target === null ||
      !selectedPaths.has(path.resolve(change.storePath)) ||
      readPreparedSessionSharingChange(change) === undefined
    ) {
      invalidate();
    }
  };
  releases.push(
    sessionChanges.subscribeFacts(changed),
    onSessionIdentityMutation((change) => {
      if (
        change.agentId === agentId &&
        change.previous.sessionKeys.some((key) => initialStoreKeys.includes(key))
      ) {
        invalidate();
      }
    }),
  );
  try {
    const parsedAgent = parseAgentSessionKey(params.sessionKey)?.agentId;
    const discoveryInventory = prepareSessionStoreTargetInventory(params.cfg, [
      agentId,
      ...(parsedAgent ? [parsedAgent] : []),
    ]);
    const candidateIdentities = discoveryInventory.candidates.map((candidate) => ({
      candidate,
      identity: readDatabasePathIdentitySync(candidate.path),
    }));
    const missingCandidates = candidateIdentities.filter(
      ({ identity }) => identity.birthtime === undefined,
    );
    // Existing sources can publish while writer admission or inventory discovery waits.
    // Capture their postimages now; later row reads initialize this same acquisition.
    for (const { candidate, identity } of candidateIdentities) {
      if (identity.birthtime !== undefined) {
        retainCandidate(candidate);
        acquireSource(candidate.path, initialStoreKeys);
      }
    }
    if (params.storageReady) {
      waitingForStorage = true;
      await params.storageReady;
      waitingForStorage = false;
      beforeDiscovery = false;
      for (const captured of missingCandidates) {
        captured.identity = readDatabasePathIdentitySync(captured.candidate.path);
      }
    }
    assertActive();
    // Writer admission may create an absent store; retain its admitted source afterward.
    for (const { candidate } of missingCandidates) {
      retainCandidate(candidate);
      acquireSource(candidate.path, initialStoreKeys);
    }
    let readFacts = () => facts!;
    const { candidates: discoveryCandidates, ...inventory } = discoveryInventory;
    const preparedSources: Array<{
      agentId: string;
      path: string;
      identity: string;
      birthtime: string;
    }> = [];
    const inventoryRead = prepareSessionStoreTargetInventoryRead(
      discoveryInventory,
      createSessionStoreRegistryMutationFilter({
        captured: candidateIdentities.map(({ candidate, identity }) => ({
          candidate,
          identity: identity.key,
          birthtime: identity.birthtime,
        })),
        preparedSources,
        registryDiscovery: inventory.registryDiscovery,
      }),
    );
    const assertPaths = () => {
      for (const { candidate, identity } of candidateIdentities) {
        const current = readDatabasePathIdentitySync(candidate.path);
        if (
          captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
            candidate.physicalPath ||
          !isDeepStrictEqual(current, identity)
        ) {
          throw new SessionMutationFactsUnavailableError();
        }
      }
    };
    assertRegistryPublication = () => {
      inventoryRead.assertRegistryCurrent();
      assertPaths();
    };
    const members = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof readSessionEntriesFromStoreInWorker>>["sharing"]>
    >();
    const retainedReads = new Map<string, ReturnType<typeof retainPreparedSessionSharingFacts>>();
    const selected = await inventoryRead.withRead(async (sources, assertDiscoveryCurrent) => {
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
          preserveQualifiedAddress: params.preserveQualifiedAddress,
          env: inventory.env,
          targetDiscoveryCache,
        },
        async (reads, select) => {
          for (const read of reads) {
            assertActive();
            const loaded = await readSessionEntriesFromStoreInWorker(
              {
                agentId: read.agentId ?? agentId,
                storePath: read.storePath,
                sessionKeys: read.options.exactKeys!,
                projection: "sharing",
                includeAuthorization: true,
                env: inventory.env,
              },
              (source) => {
                assertActive();
                if (acquireSource(source.path, read.options.exactKeys!)) {
                  acquiringPaths.add(path.resolve(read.storePath));
                }
              },
            );
            assertActive();
            const store = Object.fromEntries(
              loaded.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
            );
            read.result = ok(store);
            if (loaded.sharing) {
              const source = loaded.databaseIdentity;
              if (
                !source ||
                !source.incarnation ||
                source.filename !== loaded.sharing.source.path ||
                `file:${source.identity}` !== loaded.sharing.databaseIdentity ||
                source.birthtime === undefined
              ) {
                throw new SessionMutationFactsUnavailableError();
              }
              assertPaths();
              assertExistingDatabaseIdentity(
                loaded.sharing.source.path,
                loaded.sharing.databaseIdentity,
                source.birthtime,
              );
              preparedSources.push({
                ...loaded.sharing.source,
                identity: loaded.sharing.databaseIdentity,
                birthtime: source.birthtime,
              });
              read.readSource = loaded.sharing.source;
              members.set(read.storePath, loaded.sharing);
              for (const sessionKey of read.options.exactKeys!) {
                const key = `${loaded.sharing.databaseIdentity}\0${sessionKey}`;
                const retained = acquiringReads.get(key);
                if (!retained) {
                  throw new SessionMutationFactsUnavailableError();
                }
                retainedReads.set(key, retained);
                if (!initializedReads.has(key)) {
                  const entry = store[sessionKey];
                  retained.initialize({
                    entry: entry ? projectSessionSharingEntry(entry) : undefined,
                    placeholder: loaded.sharing.placeholders.find(
                      (row) => row.sessionKey === sessionKey,
                    ),
                    membership: new Set(
                      loaded.sharing.members.find((row) => row.sessionKey === sessionKey)
                        ?.identityIds,
                    ),
                  });
                  initializedReads.add(key);
                }
                const current = retained.readCurrent();
                if (!current) {
                  throw new SessionMutationFactsUnavailableError();
                }
                if (current.entry) {
                  store[sessionKey] = current.entry;
                }
              }
            }
          }
          return select();
        },
      );
      assertDiscoveryCurrent();
      return target;
    });
    assertActive();
    const storageTarget = Object.freeze({
      agentId: selected.agentId,
      canonicalKey: selected.canonicalKey,
      storePath: selected.storePath,
    });
    const match = findCanonicalStoreMatch(selected.store, selected.storeKeys);
    const sharing = members.get(selected.storePath);
    selectedPaths.add(path.resolve(selected.storePath));
    if (sharing) {
      selectedPaths.add(path.resolve(sharing.source.path));
      // New and existing rows retain the captured aliases of the same physical store.
      // Creation writers publish through the logical alias used during preparation.
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
      selectedDatabaseIdentity = sharing.databaseIdentity;
    }
    if (!match) {
      if (!params.allowMissing) {
        throw new SessionMutationFactsUnavailableError();
      }
      facts = { target: null, membership: new Set() };
      const retained = sharing && retainedReads.get(`${sharing.databaseIdentity}\0${canonicalKey}`);
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
        sourceAgentId: sharing.source.agentId,
        target,
        membership: new Set(
          sharing.members.find((member) => member.sessionKey === match.key)?.identityIds,
        ),
      };
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
          sourceAgentId: sharing.source.agentId,
          target: { ...target, entry: current.entry },
          membership: current.membership,
        };
      };
    }
    assertSource = () => {
      inventoryRead.assertRegistryCurrent();
      assertPaths();
      for (const source of preparedSources) {
        assertExistingDatabaseIdentity(source.path, source.identity, source.birthtime);
      }
      for (const read of retainedReads.values()) {
        if (!read.readCurrent()) {
          throw new SessionMutationFactsUnavailableError();
        }
      }
    };
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
            databaseIdentity: selectedDatabaseIdentity,
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
        databaseIdentity: selectedDatabaseIdentity,
      });
      creation = operation;
    };
    return { storageTarget, bindCreation, readCurrent, release };
  } catch (error) {
    release();
    throw waitingForStorage || error instanceof SessionMutationFactsUnavailableError
      ? error
      : new SessionMutationFactsUnavailableError({ cause: error });
  }
}
