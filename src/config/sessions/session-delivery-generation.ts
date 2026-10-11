import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasPendingSqliteNativeExecution } from "../../infra/sqlite-native-observer.js";
import {
  readSqliteNativeMutationRevision,
  registerSqliteSchemaMutationListener,
} from "../../infra/sqlite-schema-facts.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { isCronRunSessionKey, isCronSessionKey } from "../../sessions/session-key-utils.js";
import { isSessionLifecycleMutationActive } from "../../sessions/session-lifecycle-admission.js";
import {
  isSessionStoreTopologyChange,
  sessionChanges,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  isOpenClawAgentDatabaseRegistryChange,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "../../state/openclaw-agent-db-registry-listing.js";
import {
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { readSessionEntryCreatedEntry } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { assertSessionEntryCreationPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  retainPreparedSessionGenerationFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import type {
  SessionEntryCreationOperation,
  SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { readSessionEntryGenerationInDatabase } from "./session-accessor.sqlite-entry-read.js";
import { loadSessionEntryReadOnlyResultInScope } from "./session-accessor.sqlite-entry.js";
import { readCommittedIncognitoSessionSharing } from "./session-accessor.sqlite-incognito-sharing.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import {
  SessionDeliveryGenerationRevokedError,
  SessionDeliveryGenerationUnavailableError,
  isSessionDeliveryGenerationRevokedError,
  isSessionDeliveryGenerationUnavailableError,
} from "./session-delivery-generation-errors.js";
import { prepareMemorySessionGeneration } from "./session-delivery-generation-memory.js";
import type {
  SessionDeliveryGeneration,
  SessionGenerationEntry,
  SessionGenerationFacts,
} from "./session-delivery-generation.types.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { isSessionStoreReadCandidateCurrent } from "./session-store-read-candidates.js";
import {
  captureSessionStoreReadCandidates,
  createSessionStoreRegistryMutationFilter,
} from "./session-store-target-inventory.js";

export { isSessionDeliveryGenerationRevokedError } from "./session-delivery-generation-errors.js";

function isSessionGenerationFacts(value: unknown): value is SessionGenerationFacts {
  return (
    isRecord(value) &&
    [value.agentId, value.storePath, value.sessionKey].every(
      (field) => typeof field === "string" && field.length > 0 && field === field.trim(),
    ) &&
    (value.sessionId === null ||
      (typeof value.sessionId === "string" &&
        value.sessionId.length > 0 &&
        value.sessionId === value.sessionId.trim())) &&
    typeof value.storePath === "string" &&
    path.isAbsolute(value.storePath) &&
    (value.lifecycleRevision === null ||
      (typeof value.lifecycleRevision === "string" && value.lifecycleRevision.length > 0))
  );
}

/** Prepare once per delivery attempt; committed entry publications keep final I/O checks live. */
async function prepareSessionGenerationLease(
  input: SessionGenerationFacts,
  onRevoked?: (reason: unknown) => void,
): Promise<{
  assertCurrent: SessionSourceAssertion;
  assertDeliveryCurrent: () => void;
  readSessionSettings: () => Pick<SessionSharingEntry, "permissionMode" | "toolOverrides">;
  prepareRead: () => Promise<void> | undefined;
  release: () => void;
  bindCreation: (
    operation: SessionEntryCreationOperation,
    publishBinding?: (
      binding: Pick<SessionGenerationEntry, "sessionId" | "lifecycleRevision">,
    ) => void,
  ) => () => void;
  isCreationAdopted: () => boolean;
}> {
  if (!isSessionGenerationFacts(input)) {
    throw new SessionDeliveryGenerationUnavailableError();
  }
  const memory = getSessionActorStorageBinding(input);
  if (memory) {
    return prepareMemorySessionGeneration(memory, input, onRevoked);
  }
  const generation = { ...input };
  const binding = captureIncognitoSessionBinding(generation);
  const releases: Array<() => void> = [];
  const paths = new Set([path.resolve(generation.storePath)]);
  let active = true;
  let invalidated = false;
  let revoked = false;
  let publications = 0;
  let creation: SessionEntryCreationOperation | undefined;
  let creationAdopted = false;
  let publishCreatedBinding:
    | ((binding: Pick<SessionGenerationEntry, "sessionId" | "lifecycleRevision">) => void)
    | undefined;
  let databaseIdentity: string | undefined;
  let retained: ReturnType<typeof retainPreparedSessionGenerationFacts> | undefined;
  let observeIncognito: (() => void) | undefined;
  let assertRegistryPublication: (() => void) | undefined;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    for (const stop of releases.splice(0).toReversed()) {
      stop();
    }
  };
  const revoke = () => {
    release();
    onRevoked?.(new SessionDeliveryGenerationUnavailableError());
  };
  const assertActive = () => {
    if (revoked) {
      throw new SessionDeliveryGenerationRevokedError();
    }
    if (!active || invalidated) {
      throw new SessionDeliveryGenerationUnavailableError();
    }
  };
  const checkEntry = (entry: SessionGenerationEntry | null | undefined, committed = true) => {
    if (entry === undefined) {
      throw new SessionDeliveryGenerationUnavailableError();
    }
    if (
      (entry?.sessionId ?? null) !== generation.sessionId ||
      (entry?.lifecycleRevision ?? null) !== generation.lifecycleRevision
    ) {
      if (!committed) {
        throw new SessionDeliveryGenerationUnavailableError();
      }
      revoked = true;
      throw new SessionDeliveryGenerationRevokedError();
    }
    return entry;
  };
  const changed = (change: SessionRowChange) => {
    if ("all" in change) {
      if (isSessionStoreTopologyChange(change)) {
        // Only canonical registry evidence can prove a topology publication irrelevant.
        if (isOpenClawAgentDatabaseRegistryChange(change) && assertRegistryPublication) {
          try {
            assertRegistryPublication();
          } catch {
            invalidated = true;
          }
        } else {
          invalidated = true;
        }
        return;
      }
      if (typeof change.scope === "object") {
        if (change.scope.agentId && change.scope.agentId !== generation.agentId) {
          return;
        }
        if (change.scope.storePath && !paths.has(path.resolve(change.scope.storePath))) {
          return;
        }
      } else if (
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
      invalidated = true;
      return;
    }
    if (
      change.scope === "automation" ||
      change.scope === "acp" ||
      change.sessionKey !== generation.sessionKey ||
      (change.agentId && change.agentId !== generation.agentId) ||
      !change.storePath ||
      !paths.has(path.resolve(change.storePath))
    ) {
      return;
    }
    publications += 1;
    if (
      !change.factsInvalidated &&
      ["unchanged", "participants", "category", "member"].includes(change.facts?.kind ?? "")
    ) {
      return;
    }
    if (creation && !creationAdopted) {
      const created = readSessionEntryCreatedEntry(change, creation);
      if (created && retained?.adoptCreatedEntry(created)) {
        generation.sessionId = created.sessionId;
        generation.lifecycleRevision = created.lifecycleRevision ?? null;
        creationAdopted = true;
        publishCreatedBinding?.({
          sessionId: created.sessionId,
          lifecycleRevision: created.lifecycleRevision,
        });
      } else {
        revoked = true;
      }
    }
    if (binding && observeIncognito) {
      try {
        observeIncognito();
      } catch (error) {
        if (!isSessionDeliveryGenerationRevokedError(error)) {
          invalidated = true;
        }
      }
    } else if (!isPreparedSessionSharingChange(change)) {
      invalidated = true;
    } else if (observeIncognito && change.facts?.kind === "removed") {
      revoked = true;
    } else if (observeIncognito) {
      // Observe each committed transition, even if another write restores the old values.
      try {
        observeIncognito();
      } catch (error) {
        if (!isSessionDeliveryGenerationRevokedError(error)) {
          invalidated = true;
        }
      }
    }
  };
  releases.push(sessionChanges.subscribeFacts(changed));
  try {
    let readCurrent: () => SessionGenerationEntry | null;
    let workerSource: SessionSourceAssertion | undefined;
    let prepareRead: () => Promise<void> | undefined = () => {
      assertActive();
      return undefined;
    };
    if (binding) {
      const { actor, admissionSignal } = binding;
      const claim = actor.sessions.captureCurrent(generation.sessionKey);
      readCurrent = () => {
        admissionSignal?.throwIfAborted();
        actor.assertReadable();
        claim.assertCurrent();
        return checkEntry(actor.sessions.readSharing(generation.sessionKey)?.entry ?? null);
      };
      observeIncognito = readCurrent;
    } else if (isIncognitoSessionKey(generation.sessionKey)) {
      const database = getOpenIncognitoAgentDatabase(generation.agentId, generation.storePath);
      if (!database && generation.sessionId !== null) {
        throw new SessionDeliveryGenerationRevokedError();
      }
      releases.push(
        registerOpenClawAgentDatabaseAsyncResource({
          agentId: generation.agentId,
          path: generation.storePath,
          revoke,
          close: async () => revoke(),
        }),
      );
      readCurrent = () => {
        if (getOpenIncognitoAgentDatabase(generation.agentId, generation.storePath) !== database) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        if (!database) {
          return checkEntry(null);
        }
        const committed = readCommittedIncognitoSessionSharing(database.db, generation.sessionKey);
        if (committed === undefined && generation.sessionId === null) {
          // Temporary process-held compatibility: only its existing native reader can
          // prove rowless absence. An unavailable/pending projection still throws above.
          const read = loadSessionEntryReadOnlyResultInScope({
            agentId: generation.agentId,
            storePath: generation.storePath,
            sessionKey: generation.sessionKey,
          });
          if (!read.ok) {
            throw read.error;
          }
          return checkEntry(read.value ?? null);
        }
        return checkEntry(committed?.entry ?? (committed ? null : undefined));
      };
      observeIncognito = readCurrent;
    } else {
      const candidates = captureSessionStoreReadCandidates(generation.storePath);
      const originalSources = new Map(
        candidates.map((candidate) => [
          path.resolve(candidate.physicalPath),
          readDatabasePathIdentitySync(candidate.physicalPath),
        ]),
      );
      const preparedSources: Array<{
        agentId: string;
        path: string;
        identity: string;
        birthtime: string;
      }> = [];
      // Capture registry selection before worker I/O; keep its witness for the lease lifetime.
      const unchangedByRegistry = createSessionStoreRegistryMutationFilter({
        captured: candidates.map((candidate) => ({
          candidate,
          identity: originalSources.get(path.resolve(candidate.physicalPath))!.key,
          birthtime: originalSources.get(path.resolve(candidate.physicalPath))!.birthtime,
        })),
        preparedSources,
      });
      const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead(
        {},
        (mutation, entries) => {
          // Until selection completes, canonical candidates have no verified physical owner.
          // Do not consume a relevant transition before preparedSources can fence it.
          if (
            preparedSources.length === 0 &&
            mutation.sources.some(
              (source) =>
                originalSources.has(source.path) ||
                originalSources.has(source.physicalPath) ||
                [...originalSources.values()].some((identity) => identity.key === source.identity),
            )
          ) {
            return false;
          }
          return unchangedByRegistry(mutation, entries);
        },
      );
      const assertCandidatePaths = () => {
        for (const candidate of candidates) {
          if (!isSessionStoreReadCandidateCurrent(candidate)) {
            throw new SessionDeliveryGenerationUnavailableError();
          }
        }
      };
      assertRegistryPublication = () => {
        registryRead.assertCurrent();
        assertCandidatePaths();
      };
      for (const candidate of candidates) {
        paths.add(path.resolve(candidate.path));
        paths.add(path.resolve(candidate.physicalPath));
        for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
          releases.push(
            registerOpenClawAgentDatabaseReadCandidateResource({
              ...candidate,
              path: pathname,
              revoke,
              close: async () => revoke(),
            }),
          );
        }
      }
      let source: { path: string; identity: string } | undefined;
      let assertNativeCurrent: (entry: SessionGenerationEntry | null) => void = () => {};
      while (!retained) {
        assertActive();
        const before = publications;
        retained = await withSessionEntriesFromStoresInWorker(
          [
            {
              ...generation,
              sessionKeys: [generation.sessionKey],
              projection: "sharing",
              includeAuthorization: true,
            },
          ],
          ([read]) => {
            assertActive();
            if (before !== publications) {
              return undefined;
            }
            const entry = read!.result.entries.find(
              (row) => row.sessionKey === generation.sessionKey,
            )?.entry;
            checkEntry(entry ?? null);
            const sharing = read!.result.sharing;
            if (sharing) {
              const identity = readDatabasePathIdentitySync(sharing.source.path);
              const workerIdentity = read!.result.databaseIdentity;
              if (
                !workerIdentity?.incarnation ||
                workerIdentity.filename !== sharing.source.path ||
                "file:" + workerIdentity.identity !== sharing.databaseIdentity ||
                identity.key !== sharing.databaseIdentity ||
                identity.birthtime === undefined ||
                identity.birthtime !== workerIdentity.birthtime
              ) {
                throw new SessionDeliveryGenerationUnavailableError();
              }
              source = { path: sharing.source.path, identity: sharing.databaseIdentity };
              preparedSources.push({
                agentId: read!.database.agentId,
                ...source,
                birthtime: identity.birthtime,
              });
            } else {
              const pathname = path.resolve(read!.database.path);
              const original = originalSources.get(pathname);
              // The existing-only worker returns no sharing metadata for a missing file.
              // Retain that exact absent source; creation can never inherit this selection.
              if (
                generation.sessionId !== null ||
                !original?.key.startsWith("path:") ||
                readDatabasePathIdentitySync(pathname).key !== original.key
              ) {
                throw new SessionDeliveryGenerationUnavailableError();
              }
              source = { path: pathname, identity: original.key };
            }
            paths.add(path.resolve(source.path));
            databaseIdentity = source.identity;
            const prepared = retainPreparedSessionGenerationFacts({
              databaseIdentity: source.identity,
              sessionKey: generation.sessionKey,
              entry: entry ? projectSessionSharingEntry(entry) : undefined,
            });
            releases.push(prepared.release);
            const nativeOptions = { ...read!.database, path: source.path };
            let native = getOpenClawAgentDatabaseIfOpen(nativeOptions);
            let nativeRevision = native && readSqliteNativeMutationRevision(native.db);
            const schemaChanged = () => {
              invalidated = true;
            };
            if (native) {
              releases.push(registerSqliteSchemaMutationListener(native.db, schemaChanged));
            }
            assertNativeCurrent = (current) => {
              const opened = getOpenClawAgentDatabaseIfOpen(nativeOptions);
              if (!native && opened) {
                native = opened;
                nativeRevision = undefined;
                releases.push(registerSqliteSchemaMutationListener(native.db, schemaChanged));
              } else if (opened !== native) {
                invalidated = true;
                throw new SessionDeliveryGenerationUnavailableError();
              }
              if (!native) {
                return;
              }
              // Native callbacks and unfinished cursors cannot certify a committed write set.
              if (hasPendingSqliteNativeExecution(native.db)) {
                throw new SessionDeliveryGenerationUnavailableError();
              }
              const revision = readSqliteNativeMutationRevision(native.db);
              if (revision === undefined) {
                throw new SessionDeliveryGenerationUnavailableError();
              }
              if (revision === nativeRevision) {
                return;
              }
              const committed = !native.db.isTransaction;
              // Raw same-handle commits do not publish complete entry facts.
              // Keep their final native guard until managed raw settlement is complete.
              try {
                const observed = checkEntry(
                  readSessionEntryGenerationInDatabase(native, generation.sessionKey) ?? null,
                  committed,
                );
                if (
                  observed?.permissionMode !== current?.permissionMode ||
                  !isDeepStrictEqual(observed?.toolOverrides, current?.toolOverrides) ||
                  readSqliteNativeMutationRevision(native.db) !== revision
                ) {
                  throw new SessionDeliveryGenerationUnavailableError();
                }
                assertActive();
                nativeRevision = revision;
              } catch (error) {
                // Tentative native changes may roll back; committed revocation stays permanent.
                if (committed) {
                  invalidated = true;
                }
                throw error;
              }
            };
            return prepared;
          },
        );
      }
      const assertSourceCurrent = () => {
        assertActive();
        registryRead.assertCurrent();
        assertCandidatePaths();
        if (!source || readDatabasePathIdentitySync(source.path).key !== source.identity) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
      };
      readCurrent = () => {
        assertSourceCurrent();
        const entry = checkEntry(retained?.readCurrent());
        assertNativeCurrent(entry);
        return entry;
      };
      prepareRead = () => {
        assertSourceCurrent();
        return retained?.prepareRead()?.then(assertSourceCurrent);
      };
      if (generation.sessionId !== null && source) {
        workerSource = captureSessionEntrySourceAssertion({
          scope: { ...generation, storePath: source.path },
          expected: {
            sessionId: generation.sessionId,
            lifecycleRevision: generation.lifecycleRevision ?? undefined,
          },
          fields: ["sessionId", "lifecycleRevision"],
          assertCurrent: () => readCurrent(),
          assertHostCurrent: assertSourceCurrent,
          refuse: () => {
            revoked = true;
            throw new SessionDeliveryGenerationRevokedError();
          },
        });
      }
    }
    const assertCurrent = (delivery = false) => {
      try {
        assertActive();
        if (
          delivery &&
          [...paths].some((scope) =>
            isSessionLifecycleMutationActive(
              scope,
              generation.sessionId
                ? [generation.sessionKey, generation.sessionId]
                : [generation.sessionKey],
            ),
          )
        ) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        return readCurrent();
      } catch (error) {
        const failure =
          isSessionDeliveryGenerationRevokedError(error) ||
          isSessionDeliveryGenerationUnavailableError(error)
            ? error
            : new SessionDeliveryGenerationUnavailableError({ cause: error });
        onRevoked?.(failure);
        throw failure;
      }
    };
    for (let pending = prepareRead(); pending; pending = prepareRead()) {
      await pending;
    }
    assertCurrent();
    if (onRevoked) {
      let checkedPublications = publications;
      // Public notifications run after every committed generation fact is installed.
      releases.push(
        sessionChanges.subscribe(() => {
          if (checkedPublications === publications && !invalidated && !revoked) {
            return;
          }
          checkedPublications = publications;
          try {
            assertCurrent();
          } catch {
            // assertCurrent has already revoked the execution owner.
          }
        }),
      );
    }
    return {
      assertCurrent: workerSource
        ? composeSessionSourceAssertion([workerSource], (assertSource) => {
            try {
              assertActive();
              assertSource();
            } catch (error) {
              const failure =
                isSessionDeliveryGenerationRevokedError(error) ||
                isSessionDeliveryGenerationUnavailableError(error)
                  ? error
                  : new SessionDeliveryGenerationUnavailableError({ cause: error });
              onRevoked?.(failure);
              throw failure;
            }
          })
        : assertCurrent,
      assertDeliveryCurrent: () => assertCurrent(true),
      readSessionSettings: () => {
        const current = assertCurrent();
        // Identity-preserving writes may bypass generation readiness, but a pending
        // policy publication cannot donate stale permissions to retained work.
        const entry = retained ? checkEntry(retained.readSessionSettings()) : current;
        return {
          permissionMode: entry?.permissionMode,
          toolOverrides: entry?.toolOverrides,
        };
      },
      prepareRead,
      release,
      bindCreation: (operation, publishBinding) => {
        assertCurrent();
        if (creation) {
          throw new Error("Session creation admission changed; retry against the current session");
        }
        if (generation.sessionId !== null || !retained || !databaseIdentity) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        const target = {
          agentId: generation.agentId,
          sessionKey: generation.sessionKey,
          paths,
          databaseIdentity,
        };
        assertSessionEntryCreationPublication(operation, target);
        creation = operation;
        publishCreatedBinding = publishBinding;
        return () => {
          if (creationAdopted) {
            assertCurrent();
            return;
          }
          assertActive();
          assertSessionEntryCreationPublication(operation, target);
        };
      },
      isCreationAdopted: () => creationAdopted,
    };
  } catch (error) {
    release();
    if (
      isSessionDeliveryGenerationRevokedError(error) ||
      isSessionDeliveryGenerationUnavailableError(error)
    ) {
      throw error;
    }
    throw new SessionDeliveryGenerationUnavailableError({ cause: error });
  }
}

/** Session lifecycle owners compose these facts with their own admitted mutation authority. */
export async function prepareSessionGenerationFacts(input: SessionGenerationFacts) {
  const {
    assertCurrent,
    prepareRead,
    readSessionSettings,
    release,
    bindCreation,
    isCreationAdopted,
  } = await prepareSessionGenerationLease(input);
  return {
    assertCurrent,
    prepareRead,
    readSessionSettings,
    release,
    bindCreation,
    isCreationAdopted,
  };
}

/** Stable cron roots retain their admitted run; exact-run keys already name one generation. */
export async function prepareCronRootSessionGeneration(
  input: Omit<SessionDeliveryGeneration, "lifecycleRevision"> & { lifecycleRevision?: string },
  onRevoked?: (reason: unknown) => void,
) {
  if (!isCronSessionKey(input.sessionKey) || isCronRunSessionKey(input.sessionKey)) {
    return undefined;
  }
  const { assertCurrent, release } = await prepareSessionGenerationLease(
    {
      ...input,
      lifecycleRevision: input.lifecycleRevision ?? null,
    },
    onRevoked,
  );
  return { assertCurrent, release };
}

/** Delivery remains unavailable while any lifecycle mutation owns the session. */
export async function prepareSessionDeliveryGeneration(input: SessionDeliveryGeneration) {
  if (!isSessionGenerationFacts(input) || input.sessionId === null) {
    throw new SessionDeliveryGenerationUnavailableError();
  }
  const lease = await prepareSessionGenerationLease(input);
  try {
    lease.assertDeliveryCurrent();
    return { assertCurrent: lease.assertDeliveryCurrent, release: lease.release };
  } catch (error) {
    lease.release();
    throw error;
  }
}
