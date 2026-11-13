import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import {
  canShareSqliteDatabaseAdmissions,
  retainSqliteDatabaseAdmissionForPath,
} from "../../infra/sqlite-database-admission.js";
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
import { createLeaseDiagnostics } from "./session-delivery-generation-diagnostics.js";
import {
  SessionDeliveryGenerationRevokedError,
  SessionDeliveryGenerationUnavailableError,
} from "./session-delivery-generation-errors.js";
import { prepareMemorySessionGeneration } from "./session-delivery-generation-memory.js";
import {
  createSessionGenerationReadBatch,
  type GenerationRead,
} from "./session-delivery-generation-read-batch.js";
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
  initialRead: GenerationRead = withSessionEntriesFromStoresInWorker,
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
  let readGeneration = initialRead;
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
  const diag = createLeaseDiagnostics(() => ({ active, invalidated, revoked }));
  const release = () => {
    if (!active) {
      return;
    }
    diag.flip("released");
    active = false;
    for (const stop of releases.splice(0).toReversed()) {
      stop();
    }
  };
  const revoke = () => {
    diag.flip("resource-revoked");
    release();
    onRevoked?.(new SessionDeliveryGenerationUnavailableError());
  };
  const assertActive = () => {
    if (revoked) {
      throw new SessionDeliveryGenerationRevokedError();
    }
    if (!active) {
      throw diag.unavailable("active-closed");
    }
    if (invalidated) {
      throw diag.unavailable("active-invalidated");
    }
  };
  const refuseCurrent = (error: unknown): never => {
    const failure = diag.fallback("current-fallback", error);
    onRevoked?.(failure);
    throw failure;
  };
  const checkEntry = (entry: SessionGenerationEntry | null | undefined, committed = true) => {
    if (entry === undefined) {
      throw diag.unavailable("entry-missing");
    }
    if (
      (entry?.sessionId ?? null) !== generation.sessionId ||
      (entry?.lifecycleRevision ?? null) !== generation.lifecycleRevision
    ) {
      if (!committed) {
        throw diag.unavailable("entry-tentative");
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
      diag.flip("row-invalidated");
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
      diag.flip("row-invalidated");
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
      const readInitialGeneration = readGeneration;
      readGeneration = withSessionEntriesFromStoresInWorker;
      retained = await readInitialGeneration(
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
              throw diag.unavailable("initial-identity");
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
              throw diag.unavailable("initial-absence");
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
            diag.flip("schema-invalidated");
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
              diag.flip("check-detected");
              invalidated = true;
              throw diag.unavailable("native-handle");
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
              throw diag.unavailable("native-pending");
            }
            const revision = readSqliteNativeMutationRevision(native.db);
            if (revision === undefined) {
              throw diag.unavailable("native-revision");
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
                throw diag.unavailable("native-policy");
              }
              assertActive();
              nativeRevision = revision;
            } catch (error) {
              // Tentative native changes may roll back; committed revocation stays permanent.
              if (committed) {
                diag.flip("check-detected");
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
                throw diag.unavailable("effect-native");
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
                throw diag.unavailable("effect-identity");
              }
              const observed = checkEntry(
                result.entries.find((row) => row.sessionKey === generation.sessionKey)?.entry ??
                  null,
              );
              if (
                observed?.permissionMode !== current?.permissionMode ||
                !isDeepStrictEqual(observed?.toolOverrides, current?.toolOverrides)
              ) {
                diag.flip("check-detected");
                invalidated = true;
                throw diag.unavailable("effect-policy");
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
                diag.flip("check-detected");
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
    const sharedAdmission = canShareSqliteDatabaseAdmissions();
    const admission =
      sharedAdmission && source && retainSqliteDatabaseAdmissionForPath(source.path);
    if (admission) {
      releases.push(admission.release);
    } else if (sharedAdmission && source?.identity.key.startsWith("file:")) {
      throw diag.unavailable("admission-missing");
    }
    const readCurrent = () => {
      assertActive();
      if (!source || (admission && !admission.isCurrent())) {
        throw diag.unavailable("source-admission");
      }
      // Unhosted workers cannot share admission and retain their native source checks.
      if (!sharedAdmission) {
        assertDatabasePathIdentity(source.path, source.identity);
      }
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
          throw diag.unavailable("delivery-mutation");
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
          throw diag.unavailable("effect-source");
        }
        await prepareSessionStoreCandidatesInWorker({
          validate: { candidates, sources: [source] },
        });
        const assertEffectCurrent = () =>
          checkGenerationCurrent(() => {
            prepared.assertCurrent();
            if (checkEntry(retained?.readCurrent()) !== current) {
              throw diag.unavailable("effect-entry");
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
          throw diag.unavailable("creation-binding");
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
            throw diag.unavailable("creation-fallback");
          },
        );
      },
      isCreationAdopted: () => creationAdopted,
    };
  } catch (error) {
    const failure = diag.fallback("prepare-fallback", error);
    release();
    throw failure;
  }
}

/** Session lifecycle owners compose these facts with their own admitted mutation authority. */
export async function prepareSessionGenerationFacts(input: SessionGenerationFacts) {
  const { assertDeliveryCurrent: _delivery, ...facts } = await prepareSessionGenerationLease(input);
  return facts;
}

/** Share initial worker reads while each generation retains its own live lease and checks. */
export async function prepareSessionGenerationFactsBatch(
  inputs: readonly SessionGenerationFacts[],
) {
  type Facts = Awaited<ReturnType<typeof prepareSessionGenerationFacts>>;
  const batch = createSessionGenerationReadBatch();
  // File leases register publication listeners synchronously before queuing the first read.
  const prepared = inputs.map((input) =>
    prepareSessionGenerationLease(input, undefined, batch.read).then(
      ({ assertDeliveryCurrent: _delivery, ...facts }): Result<Facts, unknown> => ok(facts),
      (error: unknown): Result<Facts, unknown> => err(error),
    ),
  );
  await batch.flush();
  return Promise.all(prepared);
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
