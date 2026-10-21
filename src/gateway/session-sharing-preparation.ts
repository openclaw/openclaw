import path from "node:path";
import { readSessionEntryCreatedEntry } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { readPreparedSessionSharingChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import {
  isPreparedSessionSharingChange,
  readSessionEntryCreationTransition,
  type SessionEntryPlaceholder,
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import type {
  SessionEntryCreationOperation,
  SessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../config/sessions/session-canonical-key-error.js";
import type { SessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
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
import type { AgentDatabaseRegistryChange } from "../state/openclaw-agent-db-contract.js";
import { isOpenClawAgentDatabaseRegistryChange } from "../state/openclaw-agent-db-registry-listing.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../state/openclaw-agent-db-resources.js";
import { readSessionSharingFactsInWorker } from "./session-sharing-facts-read.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";
import { prepareMemorySessionMutationFacts } from "./session-sharing-memory-facts.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import { captureSessionMutationRouting } from "./session-sharing-routing.js";
import type {
  PreparedSessionSourceFacts,
  PreparedSessionSharingSource,
  ExistingSessionMutationFacts,
  SessionFactsRequest,
  SessionFactsRead,
} from "./session-sharing-target.types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import { prepareGatewaySessionStoreTargetReadOnly } from "./session-utils-store-lookup.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";

export { SessionMutationFactsUnavailableError, captureSessionMutationRouting };
export type { PreparedSessionSourceFacts, SessionFactsRead };

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
  const assertRoutingCurrent = captureSessionMutationRouting(params.cfg, undefined, [params]);
  const { canonicalKey, agentId } = resolveSessionStoreIdentity(params);
  const memory = prepareMemorySessionMutationFacts(
    { ...params, agentId, canonicalKey },
    assertRoutingCurrent,
  );
  if (memory) {
    return memory;
  }
  const initialStoreKeys = [params.sessionKey.trim(), canonicalKey];
  const releases: Array<() => void> = [];
  let active = true;
  let beforeDiscovery = params.storageReady !== undefined;
  let waitingForStorage = false;
  let invalidated = false;
  let facts: PreparedSessionSourceFacts | undefined;
  let assertRegistryPublication: (() => void) | undefined;
  let followRegistration: ((change: AgentDatabaseRegistryChange) => void) | undefined;
  let creation: SessionEntryCreationOperation | undefined;
  let expectedPlaceholder: SessionEntryPlaceholder | undefined;
  let adoptCreatedEntry: ((entry: SessionSharingEntry) => void) | undefined;
  let assertSource: () => void;
  const selectedPaths = new Set<string>();
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
    // A bound reader follows its physical source, not same-key rows in other stores.
    if (facts?.target && !selectedPaths.has(path.resolve(change.storePath))) {
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
      const created = readSessionEntryCreatedEntry(change, creation);
      if (created && adoptCreatedEntry) {
        adoptCreatedEntry(created);
        creation = undefined;
        return;
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
    if (!facts || facts.target === null || readPreparedSessionSharingChange(change) === undefined) {
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
    followRegistration = inventoryRead.followRegistration;
    assertRegistryPublication = () => {
      inventoryRead.assertRegistryCurrent();
    };
    const members = new Map<string, PreparedSessionSharingSource>();
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
            const loaded = await readSessionSharingFactsInWorker(
              {
                agentId: read.agentId ?? agentId,
                storePath: read.storePath,
                sessionKeys: read.options.exactKeys!,
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
            read.result = store;
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
              members.set(read.storePath, {
                facts: loaded.sharing,
                source: {
                  ...loaded.sharing.source,
                  databaseIdentity: source.identity,
                  databaseBirthtime: source.birthtime,
                },
              });
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
                const pending = retained.prepareRead();
                if (pending) {
                  await pending;
                  assertActive();
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
    const storageTarget: SessionFactsRead<PreparedSessionMutationFacts>["storageTarget"] =
      Object.freeze({
        agentId: selected.agentId,
        canonicalKey: selected.canonicalKey,
        storePath: selected.storePath,
      });
    const match = findCanonicalStoreMatch(selected.store, selected.storeKeys);
    const selectedSharing = members.get(selected.storePath);
    const sharing = selectedSharing?.facts;
    const readSource = selectedSharing?.source;
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
    }
    if (!match) {
      if (!params.allowMissing) {
        throw new SessionMutationFactsUnavailableError();
      }
      facts = {
        target: null,
        membership: new Set(),
        sourcePath: sharing?.source.path,
        sourceAgentId: sharing?.source.agentId,
        readSource,
      };
      const retained = sharing && retainedReads.get(`${sharing.databaseIdentity}\0${canonicalKey}`);
      expectedPlaceholder = retained?.readCurrent()?.placeholder;
      adoptCreatedEntry = (entry) => {
        retained?.adoptCreatedEntry(entry);
        facts = {
          ...facts!,
          target: {
            agentId: selected.agentId,
            canonicalKey: selected.canonicalKey,
            storePath: selected.storePath,
            storeKeys: selected.storeKeys,
            storeKey: canonicalKey,
            readSource,
            entry,
          },
        };
      };
      readFacts = () => {
        const current = retained?.readCurrent();
        if (facts!.target && current?.entry) {
          return {
            ...facts!,
            target: { ...facts!.target, entry: current.entry },
            membership: current.membership,
          };
        }
        if (
          (retained && !current) ||
          current?.entry ||
          current?.placeholder?.sessionId !== expectedPlaceholder?.sessionId
        ) {
          throw new SessionMutationFactsUnavailableError();
        }
        return { ...facts!, target: null, membership: new Set<string>() };
      };
    } else {
      if (!sharing) {
        throw new SessionMutationFactsUnavailableError();
      }
      const target = {
        agentId: selected.agentId,
        canonicalKey: selected.canonicalKey,
        storePath: selected.storePath,
        readSource,
        storeKeys: selected.storeKeys,
        entry: projectSessionSharingEntry(match.entry),
        storeKey: match.key,
      };
      facts = {
        sourcePath: sharing.source.path,
        sourceAgentId: sharing.source.agentId,
        readSource,
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
          readSource,
          target: { ...target, entry: current.entry },
          membership: current.membership,
        };
      };
    }
    assertSource = () => {
      inventoryRead.assertRegistryCurrent();
    };
    const readCurrent = (cfg: OpenClawConfig) => {
      try {
        assertActive();
        assertRoutingCurrent(cfg);
        assertSource();
        return readFacts();
      } catch (error) {
        throw error instanceof SessionMutationFactsUnavailableError
          ? error
          : new SessionMutationFactsUnavailableError({ cause: error });
      }
    };
    const bindCreation = (operation: SessionEntryCreationOperation) => {
      // Existing rows already follow write receipts; only absence needs a creation transition.
      if (facts?.target === null) {
        creation = operation;
      }
    };
    const prepareRead = () => {
      if (!active) {
        return undefined;
      }
      const pending = [...acquiringReads.values()].flatMap((read) => read.prepareRead() ?? []);
      return pending.length > 0 ? Promise.all(pending).then(() => {}) : undefined;
    };
    const pending = prepareRead();
    if (pending) {
      await pending;
    }
    return { storageTarget, bindCreation, prepareRead, readCurrent, release, followRegistration };
  } catch (error) {
    release();
    throw waitingForStorage ||
      error instanceof SessionMutationFactsUnavailableError ||
      error instanceof SessionCanonicalKeyMigrationRequiredError
      ? error
      : new SessionMutationFactsUnavailableError({ cause: error });
  }
}
