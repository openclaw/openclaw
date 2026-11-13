import { stat } from "node:fs/promises";
import path from "node:path";
import { readSessionEntryCreatedEntry } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { readPreparedSessionSharingChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import {
  isPreparedSessionSharingChange,
  readSessionEntryCreationTransition,
  type SessionEntryPlaceholder,
  projectSessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import type {
  SessionEntryCreationOperation,
  SessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../config/sessions/session-canonical-key-error.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import type { SessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { createSessionStoreRegistryMutationFilter } from "../config/sessions/session-store-target-inventory.js";
import {
  captureSessionStoreEnvironment,
  captureSessionStoreInventoryRouting,
} from "../config/sessions/session-store-target-routing.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import { prepareSessionStoreCandidatesInWorker } from "../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { observeDiagnosticsTimelinePhases } from "../infra/diagnostics-timeline.js";
import { getSqliteDatabaseAdmissionSourceForPath } from "../infra/sqlite-database-admission.js";
import {
  assertDatabaseFileIdentity,
  readDatabasePathIdentity,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  isSessionStoreTopologyChange,
  sessionChangeScopeAffectsStoredRows,
  sessionChanges,
  type SessionRowChange,
} from "../sessions/session-row-changes.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import type { AgentDatabaseRegistryChange } from "../state/openclaw-agent-db-contract.js";
import {
  isOpenClawAgentDatabaseRegistryChange,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "../state/openclaw-agent-db-registry-listing.js";
import { matchesAgentDatabaseReadCandidatePath } from "../state/openclaw-agent-db-resources.js";
import {
  getPendingOpenClawAgentDatabasePreparation,
  readPendingOpenClawAgentDatabaseIdentity,
} from "../state/openclaw-agent-execution.js";
import { createSessionSharingFactAcquisition } from "./session-sharing-facts-read.js";
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
  const environment = captureSessionStoreEnvironment(params.cfg);
  const parsedAgent = parseAgentSessionKey(params.sessionKey)?.agentId;
  const agentIds = [agentId, ...(parsedAgent ? [parsedAgent] : [])];
  const routing = captureSessionStoreInventoryRouting(environment, agentIds);
  const storage =
    params.storageReady && "ready" in params.storageReady ? params.storageReady : undefined;
  const admitted = new Map<string, DatabasePathIdentity>();
  let initialDiscovery = true;

  using phases = observeDiagnosticsTimelinePhases("sessionFacts.inventory");
  // Artifact-preserving reads qualify paths off the Gateway thread.
  const inspection = isArtifactPreservingStateRead();
  const initialStoreKeys = [params.sessionKey.trim(), canonicalKey];
  const readScope = params.sessionAccessOnly ? "session-access" : "sharing";
  const releases: Array<() => void> = [];
  let active = true;
  let beforeDiscovery = params.storageReady !== undefined;
  let waitingForStorage = false;
  let invalidated = false;
  let acquisitionBoundToAgent = false;
  let facts: PreparedSessionSourceFacts | undefined;
  let assertRegistryPublication: (() => void) | undefined;
  let followRegistration: ((change: AgentDatabaseRegistryChange) => void) | undefined;
  let creation: SessionEntryCreationOperation | undefined;
  let expectedPlaceholder: SessionEntryPlaceholder | undefined;
  let adoptCreatedEntry: ((entry: SessionSharingEntry) => void) | undefined;
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
  const acquisition = createSessionSharingFactAcquisition({
    followLifecycle: params.followLifecycle,
    followTranscript: params.followTranscript,
    scope: readScope,
    inspection,
    phases,
    releases,
    release,
    assertActive,
    assertRoutingCurrent: () => assertRoutingCurrent(params.cfg),
  });
  const changed = (change: SessionRowChange) => {
    if ("all" in change) {
      if (isSessionStoreTopologyChange(change)) {
        // Another agent's admission cannot revoke this retained logical/physical store pair.
        if (initialDiscovery && isOpenClawAgentDatabaseRegistryChange(change)) {
          // The original registry cursor classifies this transition after physical qualification.
          return;
        }
        if (
          beforeDiscovery ||
          (typeof change.scope === "object" &&
            change.scope.agentId &&
            change.scope.agentId !== agentId &&
            ((!facts && acquisitionBoundToAgent) ||
              (facts?.target && change.scope.agentId !== facts.sourceAgentId)))
        ) {
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
        // Runtime and automation still invalidate this retained authority.
        !sessionChangeScopeAffectsStoredRows(change) &&
        change.scope !== "runtime" &&
        change.scope !== "automation"
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
      if (
        change.scope === "sessions" &&
        change.factsInvalidated === undefined &&
        change.runtimeSession === undefined &&
        active &&
        !invalidated &&
        facts?.target != null
      ) {
        // Committed writers install entry and membership before this catalog notification.
        // The next assertion still checks the retained physical source and current facts.
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
      acquisition.paths.has(path.resolve(change.storePath)) &&
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
        change.previous.sessionKeys.some((key) => initialStoreKeys.includes(key)) &&
        !(
          ((params.followTranscript &&
            change.kind === "replace" &&
            readPreparedSessionSharingChange(change) !== undefined) ||
            (params.followLifecycle &&
              change.kind === "reset" &&
              change.previous.sessionId === change.current.sessionId)) &&
          change.previous.sessionId !== undefined &&
          change.current.sessionKeys.some((key) => initialStoreKeys.includes(key))
        )
      ) {
        invalidate();
      }
    }),
  );
  try {
    const originalCandidates: readonly SessionStoreReadCandidate[] = [
      ...[...routing.logicalPaths].map((storePath) => {
        const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
        return Object.assign(
          { path: target.path, physicalPath: target.path },
          !target.agentId && !target.shared ? { scope: "sibling-family" as const } : {},
        );
      }),
      ...(storage?.candidates ?? []),
    ];
    for (const candidate of originalCandidates) {
      acquisition.retainCandidate(candidate);
      const opening =
        readPendingOpenClawAgentDatabaseIdentity(candidate.path) ??
        readPendingOpenClawAgentDatabaseIdentity(candidate.physicalPath);
      const source = candidate.identity
        ? { identity: candidate.identity, canonicalPath: candidate.identity.canonicalPath }
        : (getSqliteDatabaseAdmissionSourceForPath(candidate.path) ??
          (opening && {
            identity: opening.identity,
            canonicalPath: opening.identity.canonicalPath,
          }));
      if (source) {
        const identity = { ...source.identity, canonicalPath: source.canonicalPath };
        admitted.set(candidate.path, identity);
        admitted.set(identity.canonicalPath, identity);
        acquisition.retainCandidate({ path: candidate.path, physicalPath: identity.canonicalPath });
        acquisition.capture(candidate.path, initialStoreKeys, identity);
        if (
          opening &&
          opening.identity.birthtime !== undefined &&
          opening.identity.key === identity.key &&
          opening.identity.birthtime === identity.birthtime &&
          opening.identity.canonicalPath === identity.canonicalPath
        ) {
          acquisition.sources.push({
            agentId: opening.agentId,
            path: opening.identity.canonicalPath,
            identity: opening.identity.key,
            birthtime: opening.identity.birthtime,
          });
        }
      }
    }
    const capturedSources = originalCandidates.map((candidate) => ({
      candidate,
      identity: admitted.get(candidate.path)?.key,
      birthtime: admitted.get(candidate.path)?.birthtime,
    }));
    const registryScope: Parameters<typeof createSessionStoreRegistryMutationFilter>[0] = {
      captured: capturedSources,
      preparedSources: acquisition.sources,
    };
    const registryFilter = createSessionStoreRegistryMutationFilter(registryScope);
    const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead(
      { env: environment.env },
      registryFilter,
    );
    if (storage) {
      const {
        followRegistration: followRegistryRegistration,
        assertCurrent: assertRegistryCurrent,
      } = registry;
      releases.push(
        storage.observeRegistration((change) => {
          assertActive();
          assertRoutingCurrent(params.cfg);
          followRegistryRegistration(change);
          assertRegistryCurrent();
        }),
      );
    }
    const preparedInventory = await prepareSessionStoreCandidatesInWorker({
      config: environment.config,
      agentIds,
      env: environment.serialized,
    });
    assertActive();
    assertRoutingCurrent(params.cfg);
    const discoveryInventory = {
      ...preparedInventory.inventory!,
      config: environment.config,
      env: environment.env,
      ...(isArtifactPreservingStateRead("agent") ? { preserveSourceArtifacts: true as const } : {}),
    };
    const candidateIdentities = await Promise.all(
      discoveryInventory.candidates
        .filter((candidate) => !inspection || !candidate.scope)
        .map(async (candidate) => ({
          candidate,
          identity: candidate.identity ?? (await readDatabasePathIdentity(candidate.path)),
        })),
    );
    assertActive();
    assertRoutingCurrent(params.cfg);
    registryScope.registryDiscovery = discoveryInventory.registryDiscovery;
    capturedSources.splice(
      0,
      capturedSources.length,
      ...discoveryInventory.candidates.map((candidate) => {
        const original = admitted.get(candidate.path) ?? admitted.get(candidate.physicalPath);
        return { candidate, identity: original?.key, birthtime: original?.birthtime };
      }),
    );
    for (const { candidate, identity } of candidateIdentities) {
      const original = admitted.get(candidate.path) ?? admitted.get(candidate.physicalPath);
      if (
        original &&
        (original.canonicalPath !== identity.canonicalPath ||
          (original.birthtime !== undefined &&
            (original.key !== identity.key || original.birthtime !== identity.birthtime)))
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
    }
    acquisitionBoundToAgent =
      !discoveryInventory.registryDiscovery &&
      candidateIdentities.length > 0 &&
      candidateIdentities.every(
        ({ candidate, identity }) =>
          !candidate.scope &&
          identity.key.startsWith("file:") &&
          identity.birthtime !== undefined &&
          resolveUnsuffixedSqliteTargetFromSessionStorePath(candidate.path).agentId === agentId &&
          resolveUnsuffixedSqliteTargetFromSessionStorePath(candidate.physicalPath).agentId ===
            agentId,
      );
    const missingCandidates = candidateIdentities.filter(
      ({ identity }) => identity.birthtime === undefined,
    );
    // Existing sources can publish while writer admission or inventory discovery waits.
    // Capture their postimages now; later row reads initialize this same acquisition.
    for (const { candidate, identity } of candidateIdentities) {
      if (identity.birthtime !== undefined) {
        acquisition.retainCandidate(candidate);
        acquisition.capture(candidate.path, initialStoreKeys, identity);
      }
    }
    const readiness =
      params.storageReady && "ready" in params.storageReady
        ? params.storageReady.ready
        : params.storageReady;
    const preparations = readiness ? [readiness] : [];
    for (const { candidate } of candidateIdentities) {
      const pending = getPendingOpenClawAgentDatabasePreparation(candidate.physicalPath, "read");
      if (pending) {
        preparations.push(pending);
      }
    }
    if (preparations.length > 0) {
      // Discovery already joins native preparation; capture its registry witness afterward.
      beforeDiscovery = true;
      waitingForStorage = true;
      phases.mark("sessionFacts.storageReadiness");
      const ready = await Promise.all(preparations);
      for (const preparation of ready) {
        if (preparation) {
          preparation.assertCurrent();
        }
      }
      phases.mark("sessionFacts.inventory");
      waitingForStorage = false;
      beforeDiscovery = false;
      for (const { candidate, identity } of candidateIdentities) {
        if (!inspection && identity.birthtime !== undefined) {
          const current = await stat(candidate.physicalPath, { bigint: true });
          assertActive();
          assertRoutingCurrent(params.cfg);
          assertDatabaseFileIdentity(current, identity);
        }
      }
      const refreshed =
        inspection && missingCandidates.length > 0
          ? (
              await prepareSessionStoreCandidatesInWorker({
                config: environment.config,
                agentIds,
                env: environment.serialized,
              })
            ).candidates
          : undefined;
      for (const captured of missingCandidates) {
        const candidate = refreshed?.find(
          (item) => !item.scope && item.path === captured.candidate.path,
        );
        if (inspection) {
          if (!candidate?.identity || candidate.physicalPath !== captured.candidate.physicalPath) {
            throw new Error("Session source changed during storage preparation");
          }
          captured.identity = candidate.identity;
          captured.candidate.identity = candidate.identity;
        } else {
          captured.identity = await readDatabasePathIdentity(captured.candidate.path);
          captured.candidate.identity = captured.identity;
          assertActive();
          assertRoutingCurrent(params.cfg);
        }
      }
    }
    assertActive();
    registry.assertCurrent();
    initialDiscovery = false;
    // Writer admission may create an absent store; retain its admitted source afterward.
    for (const { candidate, identity } of missingCandidates) {
      acquisition.retainCandidate(candidate);
      acquisition.capture(candidate.path, initialStoreKeys, identity);
    }
    let readFacts = () => facts!;
    const { candidates: discoveryCandidates, ...inventory } = discoveryInventory;
    capturedSources.splice(
      0,
      capturedSources.length,
      ...candidateIdentities.map(({ candidate, identity }) => ({
        candidate,
        identity: identity.key,
        birthtime: identity.birthtime,
      })),
    );
    const inventoryRead = prepareSessionStoreTargetInventoryRead(
      discoveryInventory,
      registryFilter,
      undefined,
      registry,
    );
    followRegistration = inventoryRead.followRegistration;
    assertRegistryPublication = inventoryRead.assertRegistryCurrent;
    const members = new Map<string, PreparedSessionSharingSource>();
    phases.mark("sessionFacts.discovery");
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
          cfg: environment.config,
          key: params.sessionKey,
          agentId,
          preserveQualifiedAddress: params.preserveQualifiedAddress,
          env: inventory.env,
          targetDiscoveryCache,
        },
        async (reads, select) => {
          for (const read of reads) {
            read.result = await acquisition.read(
              {
                agentId: read.agentId ?? agentId,
                storePath: read.storePath,
                sessionKeys: read.options.exactKeys!,
                env: inventory.env,
              },
              (sharing) => {
                read.readSource = sharing.facts.source;
                members.set(read.storePath, sharing);
              },
            );
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
      const retained = sharing && acquisition.get(sharing.databaseIdentity, canonicalKey);
      expectedPlaceholder = retained?.readCurrent(readScope)?.placeholder;
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
        const current = retained?.readCurrent(readScope);
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
      const retained = acquisition.get(sharing.databaseIdentity, target.storeKey);
      if (!retained) {
        throw new SessionMutationFactsUnavailableError();
      }
      readFacts = () => {
        const current = retained.readCurrent(readScope);
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
    assertSource = inventoryRead.assertRegistryCurrent;
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
      return acquisition.prepareRead();
    };
    const pending = prepareRead();
    if (pending) {
      phases.mark("sessionFacts.publication");
      await pending;
      phases.mark("sessionFacts.selection");
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
