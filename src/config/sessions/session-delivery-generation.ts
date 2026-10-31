import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { hasPendingSqliteNativeExecution } from "../../infra/sqlite-native-observer.js";
import {
  readSqliteNativeMutationRevision,
  registerSqliteSchemaMutationListener,
} from "../../infra/sqlite-schema-facts.js";
import {
  assertDatabasePathIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { isSessionMutationActive } from "../../sessions/session-controller.lifecycle.js";
import { isCronRunSessionKey, isCronSessionKey } from "../../sessions/session-key-utils.js";
import {
  isSessionStoreTopologyChange,
  sessionChangeScopeAffectsStoredRows,
  sessionChanges,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import { agentDatabaseBorrowers } from "../../state/openclaw-agent-db-borrower.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../../state/openclaw-agent-db-resources.js";
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
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
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
import {
  composeSessionSourceAssertion,
  createDynamicSessionSourceAssertion,
  type PreparedSessionSourceEffect,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { prepareSessionStoreCandidatesInWorker } from "./session-transcript-worker-resources.js";
import { retainSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

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
  readSessionSettings: () =>
    | Readonly<Pick<SessionSharingEntry, "permissionMode" | "toolOverrides">>
    | undefined;
  prepareRead: () => Promise<void> | undefined;
  release: () => void;
  bindCreation: (
    operation: SessionEntryCreationOperation,
    publishBinding?: (
      binding: Pick<SessionGenerationEntry, "sessionId" | "lifecycleRevision">,
    ) => void,
  ) => SessionSourceAssertion;
  isCreationAdopted: () => boolean;
}> {
  if (!isSessionGenerationFacts(input)) {
    throw new SessionDeliveryGenerationUnavailableError();
  }
  const memory = captureSessionActorStorageOwner(
    {
      agentId: input.agentId,
      storePath: input.storePath,
      sessionKey: input.sessionKey,
      env: input.env,
    },
    { assertCurrent() {}, authorize() {} },
  );
  if (memory) {
    const prepared = await prepareMemorySessionGeneration(memory, input, onRevoked);
    Object.assign(prepared.assertCurrent, {
      prepareSessionSourceEffect: async () => ({ assertCurrent: prepared.assertCurrent }),
    });
    return prepared;
  }
  const generation = { ...input };
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
  const refuseCurrent = (error: unknown): never => {
    const failure =
      isSessionDeliveryGenerationRevokedError(error) ||
      isSessionDeliveryGenerationUnavailableError(error)
        ? error
        : new SessionDeliveryGenerationUnavailableError({ cause: error });
    onRevoked?.(failure);
    throw failure;
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
        // Registration changes do not retarget an in-flight delivery. Its selected
        // store, current permissions, and actual closure remain checked below.
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
        // Runtime and automation still invalidate this retained authority.
        !sessionChangeScopeAffectsStoredRows(change) &&
        change.scope !== "runtime" &&
        change.scope !== "automation"
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
    if (!isPreparedSessionSharingChange(change)) {
      invalidated = true;
    }
  };
  releases.push(sessionChanges.subscribeFacts(changed));
  try {
    let workerSource: SessionSourceAssertion | undefined;
    const candidates = captureSessionStoreReadCandidates(generation.storePath);
    const originalSources = new Map(
      candidates.map((candidate) => [
        path.resolve(candidate.physicalPath),
        readDatabasePathIdentitySync(candidate.physicalPath),
      ]),
    );
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
    let source: { path: string; identity: DatabasePathIdentity } | undefined;
    let assertNativeCurrent: (entry: SessionGenerationEntry | null) => void = () => {};
    let prepareNativeEffect: (
      entry: SessionGenerationEntry | null,
    ) => Promise<PreparedSessionSourceEffect> = async () => ({ assertCurrent: assertActive });
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
            source = { path: sharing.source.path, identity };
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
            source = { path: pathname, identity: original };
          }
          paths.add(path.resolve(source.path));
          databaseIdentity = source.identity.key;
          const prepared = retainPreparedSessionGenerationFacts({
            databaseIdentity: source.identity.key,
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
          if (native && !isPostgresSqlConnection(native.db)) {
            releases.push(registerSqliteSchemaMutationListener(native.db, schemaChanged));
          }
          const observeNativeHandle = (opened: typeof native) => {
            if (!native && opened) {
              native = opened;
              nativeRevision = undefined;
              if (!isPostgresSqlConnection(native.db)) {
                releases.push(registerSqliteSchemaMutationListener(native.db, schemaChanged));
              }
            } else if (opened !== native) {
              invalidated = true;
              throw new SessionDeliveryGenerationUnavailableError();
            }
            return native;
          };
          assertNativeCurrent = (current) => {
            observeNativeHandle(getOpenClawAgentDatabaseIfOpen(nativeOptions));
            if (!native) {
              return;
            }
            // Native callbacks and unfinished cursors cannot certify a committed write set.
            if (!isPostgresSqlConnection(native.db) && hasPendingSqliteNativeExecution(native.db)) {
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
          prepareNativeEffect = async (current) => {
            // This is only a handle witness. The retained generation and reader own admission.
            const readHandle = () => {
              const opened = agentDatabaseBorrowers.databases.get(nativeOptions.path);
              return opened?.db.isOpen ? opened : undefined;
            };
            const opened = observeNativeHandle(readHandle());
            // A separate reader cannot observe an uncommitted same-connection transaction.
            if (opened?.db.isTransaction) {
              return { assertCurrent: () => assertNativeCurrent(current) };
            }
            const revision = opened && readSqliteNativeMutationRevision(opened.db);
            const assertCurrent = () => {
              assertActive();
              if (
                readHandle() !== opened ||
                (opened &&
                  (opened.db.isTransaction ||
                    revision === undefined ||
                    readSqliteNativeMutationRevision(opened.db) !== revision ||
                    (!isPostgresSqlConnection(opened.db) &&
                      hasPendingSqliteNativeExecution(opened.db))))
              ) {
                throw new SessionDeliveryGenerationUnavailableError();
              }
            };
            assertCurrent();
            if (!opened || revision === nativeRevision) {
              return { assertCurrent };
            }
            const reader = retainSessionHistoryWorkerDatabase(nativeOptions);
            try {
              const result = await reader.owner.readExactEntries({
                sessionKeys: [generation.sessionKey],
                projection: "full",
                includeAuthorization: true,
                env: generation.env ?? process.env,
              });
              assertCurrent();
              reader.owner.assertCurrent();
              if (
                `file:${result.databaseIdentity?.identity}` !== source?.identity.key ||
                result.databaseIdentity?.birthtime !== source.identity.birthtime
              ) {
                throw new SessionDeliveryGenerationUnavailableError();
              }
              const observed = checkEntry(
                result.entries.find((row) => row.sessionKey === generation.sessionKey)?.entry ??
                  null,
              );
              if (
                observed?.permissionMode !== current?.permissionMode ||
                !isDeepStrictEqual(observed?.toolOverrides, current?.toolOverrides)
              ) {
                invalidated = true;
                throw new SessionDeliveryGenerationUnavailableError();
              }
              nativeRevision = revision;
              return {
                assertCurrent: () => {
                  assertCurrent();
                  reader.owner.assertCurrent();
                },
                release: reader.release,
              };
            } catch (error) {
              if (
                readHandle() === opened &&
                !opened.db.isTransaction &&
                readSqliteNativeMutationRevision(opened.db) === revision
              ) {
                invalidated = true;
              }
              reader.release();
              throw error;
            }
          };
          return prepared;
        },
      );
    }
    const readCurrent = () => {
      assertActive();
      if (!source) {
        throw new SessionDeliveryGenerationUnavailableError();
      }
      // External tool effects also use this guard, without entering a database writer.
      assertDatabasePathIdentity(source.path, source.identity);
      const entry = checkEntry(retained?.readCurrent());
      assertNativeCurrent(entry);
      return entry;
    };
    const prepareRead = () => {
      assertActive();
      return retained?.prepareRead()?.then(assertActive);
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
        assertHostCurrent: assertActive,
        refuse: () => {
          revoked = true;
          throw new SessionDeliveryGenerationRevokedError();
        },
      });
    }
    const assertCurrent = (delivery = false): void => {
      try {
        assertActive();
        if (
          delivery &&
          [...paths].some((scope) =>
            isSessionMutationActive(
              scope,
              generation.sessionId
                ? [generation.sessionKey, generation.sessionId]
                : [generation.sessionKey],
            ),
          )
        ) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        readCurrent();
      } catch (error) {
        refuseCurrent(error);
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
    const checkGenerationCurrent = (assertSource: () => void) => {
      try {
        assertActive();
        assertSource();
      } catch (error) {
        refuseCurrent(error);
      }
    };
    const assertGenerationCurrent = composeSessionSourceAssertion(
      [workerSource ?? assertCurrent],
      checkGenerationCurrent,
    );
    assertGenerationCurrent.prepareSessionSourceEffect = async () => {
      let releaseEffect: PreparedSessionSourceEffect["release"];
      try {
        assertActive();
        for (let pending = prepareRead(); pending; pending = prepareRead()) {
          await pending;
        }
        const current = checkEntry(retained?.readCurrent());
        const prepared = await prepareNativeEffect(current);
        releaseEffect = prepared.release;
        if (!source) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        await prepareSessionStoreCandidatesInWorker({
          validate: { candidates, sources: [source] },
        });
        const assertEffectCurrent = () =>
          checkGenerationCurrent(() => {
            prepared.assertCurrent();
            if (checkEntry(retained?.readCurrent()) !== current) {
              throw new SessionDeliveryGenerationUnavailableError();
            }
          });
        assertEffectCurrent();
        return { assertCurrent: assertEffectCurrent, release: prepared.release };
      } catch (error) {
        await releaseEffect?.();
        return refuseCurrent(error);
      }
    };
    return {
      assertCurrent: assertGenerationCurrent,
      assertDeliveryCurrent: () => assertCurrent(true),
      readSessionSettings: () => {
        assertGenerationCurrent();
        // Identity-preserving writes may bypass generation readiness, but a pending
        // policy publication cannot donate stale permissions to retained work.
        return checkEntry(retained?.readSessionSettings()) ?? undefined;
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
        const assertCreationCurrent = () => {
          assertActive();
          assertSessionEntryCreationPublication(operation, target);
        };
        return createDynamicSessionSourceAssertion(
          () => (creationAdopted ? assertGenerationCurrent : assertCreationCurrent),
          () => {
            throw new SessionDeliveryGenerationUnavailableError();
          },
        );
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
