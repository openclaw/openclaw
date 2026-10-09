import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import type { SqliteWorkerCloseReceipt } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import {
  closeUnclaimedSharedStateSqliteWorkers,
  isSqliteWorkerStoreAvailable,
  openAgentDatabaseSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
} from "../infra/sqlite-worker-store.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";
import {
  captureAgentDatabasePreparationCompletion,
  captureAgentDatabasePreparationJournal,
} from "./agent-database-admission.js";
import { captureAgentDeletionCleanupAdmission } from "./agent-deletion-cleanup-admission.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import {
  captureOpenClawAgentDatabaseRegistration,
  settleAgentRegistration,
  type AgentDatabaseRegistration,
} from "./openclaw-agent-db-registry-listing.js";
import {
  captureOpenClawAgentDatabaseAdmissionPublication,
  getOpenClawAgentDatabaseValidationForTransfer,
  invalidateOpenClawAgentDatabaseValidation,
  retireReplacedAgentValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  cleanupRetiredAgentDatabaseLease,
  readAgentDatabaseClosedReceipt,
  publishAgentDatabaseCloseCheckpoint,
} from "./openclaw-agent-execution-cleanup.js";
import type {
  AgentDatabaseFileExecutionIdentity,
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseFileExecutionOpen,
  AgentDatabaseExecutionScope,
  AgentDatabaseNativeGeneration,
  AgentDatabaseNativeStore as Store,
  AgentDatabaseRequestExecutionSource,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";
import { requestOpenClawAgentDatabaseIntegrityCheck } from "./openclaw-database-verify.js";
import { publishOpenClawStateDatabaseWorkerAdmission } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** A logical execution owner can replace this generation only after its native close settles. */
export function createAgentDatabaseNativeGeneration(
  agentId: string,
  pathname: string,
  context: OpenClawStateWorkerContext,
  assertLogicalCurrent: () => void,
  assertCleanupOwned: () => void,
  expectedIdentity: AgentDatabaseExecutionFileIdentity | undefined,
  acceptFileIdentity: (identity: AgentDatabaseExecutionFileIdentity) => void,
  retainVerification: () => () => Promise<void>,
  creatingIdentity?: DatabasePathIdentity,
  creationClaim?: AgentDatabaseFileExecutionOpen["creationClaim"],
): AgentDatabaseNativeGeneration {
  const input: AgentDatabaseFileExecutionOpen = {
    leaseId: randomUUID(),
    agentId,
    databasePath: pathname,
    stateDatabasePath: context.admission.databasePath,
    environment: context.environment,
    ...(expectedIdentity ? { expectedIdentity } : {}),
    ...(creatingIdentity ? { creatingIdentity } : {}),
    ...(creationClaim ? { creationClaim } : {}),
  };
  let retiring = false;
  let opening: Promise<Store | undefined> | undefined;
  let openedStore: Store | undefined;
  let openingFailure: "open-refused" | "native" | undefined;
  let closedOpeningRefusal: Error | undefined;
  let openingAdmission:
    | {
        admission: ReturnType<SqliteWorkerAdmissionFactory>["admission"];
        settled: Promise<SqliteWorkerOperationSettlement>;
      }
    | undefined;
  let closing: Promise<void> | undefined;
  let nativeIdentity: AgentDatabaseFileExecutionIdentity | undefined;
  let nativeStopped: Promise<void> | undefined;
  let readCloseReceipt: (() => SqliteWorkerCloseReceipt | undefined) | undefined;
  let lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
  let integrityCheckPending: "quick" | "full" | undefined;
  let preparationPublished = false;

  const assertCurrent = () => {
    assertLogicalCurrent();
    if (retiring) {
      throw new Error("Agent native generation is retiring");
    }
    if (openedStore && !isSqliteWorkerStoreAvailable(openedStore)) {
      throw new Error("Agent database execution lost its native owner");
    }
  };
  const admission =
    (
      source: AgentDatabaseRequestExecutionSource,
      registration?: AgentDatabaseRegistration,
      assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    ): SqliteWorkerAdmissionFactory =>
    (operation) => {
      let receiveValidation = registration
        ? captureOpenClawAgentDatabaseAdmissionPublication({ agentId, path: pathname })
        : undefined;
      if (registration) {
        registration.nativeSettlement = operation.settled;
      }
      const assertPreparationJournal = captureAgentDatabasePreparationJournal(agentId, {
        env: context.environment,
      });
      const nativeLocations = [
        pathname,
        ...(nativeIdentity ? [nativeIdentity.nativeLocation] : []),
        context.admission.databasePath,
        context.admission.identity.canonicalPath,
      ];
      const assertSourceCurrent = (identity?: AgentDatabaseFileExecutionIdentity) => {
        source.assertCurrent();
        assertCurrent();
        // The reference checks its captured constraints; this owner checks the path last.
        assertCallerCurrent?.(identity);
        if (identity) {
          assertExistingDatabaseIdentity(
            pathname,
            `file:${identity.physicalIdentity}`,
            identity.birthtime,
          );
        }
      };
      const cleanup = captureAgentDeletionCleanupAdmission(
        { agentId, path: pathname, env: context.environment },
        operation,
        assertSourceCurrent,
      );
      const observeNative = (request: SqliteWorkerAdmissionRequest): void => {
        const facts = request.facts;
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          facts.kind === "agent-registration-committed"
        ) {
          const received = facts.registration;
          if (
            !registration ||
            !lease ||
            !isRecord(received) ||
            received.agentId !== input.agentId ||
            received.agentPath !== pathname ||
            received.stateDatabasePath !== lease.sharedStatePath ||
            received.stateDatabaseIdentity !== lease.sharedStateIdentity
          ) {
            throw new Error("Agent registration commit differs from its admitted native owner");
          }
          // Revocation governs future work; it cannot erase a witnessed COMMIT.
          registration.recordCommitted({
            agentId: input.agentId,
            agentPath: pathname,
            stateDatabasePath: lease.sharedStatePath,
            stateDatabaseIdentity: lease.sharedStateIdentity,
          });
        }
      };
      const authorizeNative = (
        request: SqliteWorkerAdmissionRequest,
      ): AgentDatabaseFileExecutionIdentity | undefined => {
        const facts = request.facts;
        if (cleanup?.authorize(request)) {
          return undefined;
        }
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          facts.kind === "agent-registration-committed"
        ) {
          return undefined;
        }
        assertCurrent();
        cleanup?.assertCurrent();
        if (!nativeIdentity || creatingIdentity) {
          assertCallerCurrent?.();
        }
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          facts.kind === "agent-registration-start"
        ) {
          assertSourceCurrent();
          if (!registration || !lease || !isDeepStrictEqual(facts.lease, lease)) {
            throw new Error("Agent registration start differs from its admitted native owner");
          }
          registration.begin();
          return undefined;
        }
        if (request.stage === "prepare" && isRecord(facts) && facts.kind === "shared-owner") {
          if (!(facts.validationPort instanceof MessagePort)) {
            throw new Error("Agent worker lost its validation handoff port");
          }
          try {
            assertSourceCurrent();
            publishOpenClawStateDatabaseWorkerAdmission(context.admission);
            const received = facts.lease;
            if (
              !isDeepStrictEqual(facts.identity, context.admission.identity) ||
              !isRecord(received) ||
              received.leaseId !== input.leaseId ||
              received.agentId !== input.agentId ||
              received.path !== pathname ||
              received.ownerPid !== process.pid ||
              (received.ownerStartTime !== null && typeof received.ownerStartTime !== "number") ||
              received.sharedStatePath !== context.admission.databasePath ||
              received.sharedStateIdentity !== context.admission.identity.key
            ) {
              throw new Error("Agent worker lease differs from its captured native owner");
            }
            lease = {
              leaseId: input.leaseId,
              agentId: input.agentId,
              path: pathname,
              ownerPid: process.pid,
              ownerStartTime: received.ownerStartTime,
              sharedStatePath: context.admission.databasePath,
              sharedStateIdentity: context.admission.identity.key,
            };
            receiveValidation = captureOpenClawAgentDatabaseAdmissionPublication({
              agentId,
              path: pathname,
            });
            facts.validationPort.postMessage(
              getOpenClawAgentDatabaseValidationForTransfer({ agentId, path: pathname }),
              [],
            );
          } finally {
            facts.validationPort.close();
          }
          return undefined;
        }
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          (facts.kind === "agent-integrity-check" ||
            facts.kind === "agent-open-resume" ||
            facts.kind === "agent-validation-start")
        ) {
          assertSourceCurrent();
          if (!lease || !isDeepStrictEqual(facts.lease, lease)) {
            throw new Error("Agent open notice differs from its captured native lease");
          }
          if (facts.kind === "agent-validation-start") {
            // Lease cleanup can revoke borrowed proof. Capture before verification,
            // so a later revocation still rejects the resulting publication.
            receiveValidation = captureOpenClawAgentDatabaseAdmissionPublication({
              agentId,
              path: pathname,
            });
          }
          if (facts.kind === "agent-integrity-check") {
            if (facts.check !== "quick" && facts.check !== "full") {
              throw new Error("Agent integrity notice has an invalid check mode");
            }
            integrityCheckPending = facts.check;
          }
          return undefined;
        }
        if (request.stage === "open") {
          if (!isDeepStrictEqual(facts, input)) {
            throw new Error("Agent database open differs from its captured owner");
          }
        } else {
          const received = isRecord(facts) ? facts.identity : undefined;
          if (
            !isRecord(received) ||
            received.kind !== "file" ||
            typeof received.physicalIdentity !== "string" ||
            typeof received.birthtime !== "string" ||
            typeof received.incarnation !== "string" ||
            typeof received.nativeLocation !== "string" ||
            (nativeIdentity && !isDeepStrictEqual(received, nativeIdentity))
          ) {
            throw new Error("Agent database operation belongs to another native owner");
          }
          const receivedIdentity: AgentDatabaseFileExecutionIdentity =
            nativeIdentity ??
            Object.freeze({
              kind: "file",
              physicalIdentity: received.physicalIdentity,
              birthtime: received.birthtime,
              incarnation: received.incarnation,
              nativeLocation: received.nativeLocation,
            });
          if (
            expectedIdentity &&
            (receivedIdentity.physicalIdentity !== expectedIdentity.physicalIdentity ||
              (expectedIdentity.birthtime !== undefined &&
                receivedIdentity.birthtime !== expectedIdentity.birthtime))
          ) {
            throw new Error("Agent database operation differs from its expected physical file");
          }
          if (!nativeIdentity) {
            assertExistingDatabaseIdentity(
              pathname,
              `file:${receivedIdentity.physicalIdentity}`,
              receivedIdentity.birthtime,
            );
          }
          acceptFileIdentity({
            kind: "file",
            physicalIdentity: receivedIdentity.physicalIdentity,
            birthtime: receivedIdentity.birthtime,
            nativeLocation: receivedIdentity.nativeLocation,
          });
          assertPreparationJournal?.(
            isRecord(facts) ? facts.agentDeletionJournalPresent : undefined,
          );
          nativeIdentity ??= receivedIdentity;
          return nativeIdentity;
        }
        return undefined;
      };
      const captured = source.createAdmission({
        attachment: {
          kind: "agent-execution",
          startupJournal: assertPreparationJournal !== undefined,
          ...(cleanup ? { deletion: cleanup.guard } : {}),
        },
        nativeLocations,
        assertCurrent,
        authorize(request) {
          const identity = authorizeNative(request);
          if (request.stage === "open" && registration) {
            assertSourceCurrent();
            const creating =
              !nativeIdentity &&
              (creatingIdentity
                ? creatingIdentity.key.startsWith("path:")
                : !expectedIdentity &&
                  readDatabasePathIdentitySync(pathname).key.startsWith("path:"));
            if (creating) {
              if (
                !lease &&
                getOpenClawAgentDatabaseValidationForTransfer({ agentId, path: pathname })
              ) {
                // Absence ends retained proof even if Linux reuses the inode. Later open
                // checkpoints must preserve the publication captured by the lease handoff.
                invalidateOpenClawAgentDatabaseValidation(pathname);
              }
              registration.begin();
            }
          }
          if (
            request.stage === "prepare" &&
            identity &&
            receiveValidation &&
            isRecord(request.facts) &&
            request.facts.validation !== undefined
          ) {
            assertSourceCurrent(identity);
            receiveValidation(identity.physicalIdentity, request.facts.validation);
            receiveValidation = undefined;
          }
          assertSourceCurrent(identity);
        },
      })(operation);
      captured.admission.observeRequests(observeNative);
      return captured;
    };
  const open = (
    source: AgentDatabaseRequestExecutionSource,
    assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    createIfMissing = false,
    signal?: AbortSignal,
  ): Promise<Store | undefined> => {
    assertCurrent();
    source.assertCurrent();
    assertCallerCurrent?.();
    opening ??= (async () => {
      retireReplacedAgentValidation(agentId, pathname, expectedIdentity);
      const registration = createIfMissing
        ? captureOpenClawAgentDatabaseRegistration({
            agentId,
            agentPath: pathname,
            admission: context.admission,
            assertPublicationCurrent: context.assertPublicationCurrent,
            onRegistryChange: source.onRegistryChange,
          })
        : undefined;
      const openStore = async () => {
        const assertOpening = () => {
          assertCurrent();
          source.assertCurrent();
          assertCallerCurrent?.();
          signal?.throwIfAborted();
        };
        const store = await openAgentDatabaseSqliteWorkerStore<AgentDatabaseOperations>(
          {
            moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.agentDatabaseExecution),
            databasePath: pathname,
            input,
            existingOnly: !createIfMissing,
          },
          {
            stateContext: context,
            stateDatabasePath: context.admission.databasePath,
            assertCurrent: assertOpening,
            signal,
            createAdmission: (operation) => {
              const captured = admission(source, registration, assertCallerCurrent)(operation);
              openingAdmission = { admission: captured.admission, settled: operation.settled };
              return captured;
            },
            onNativeStopped: (stopped, readReceipt) => {
              nativeStopped = stopped;
              readCloseReceipt = readReceipt;
            },
            // A failed pooled worker also retires proof lent by its other agent actors.
            onNativeLost: () => invalidateOpenClawAgentDatabaseValidation(pathname),
          },
        );
        // Keep the native owner reachable if registration publication fails after open.
        openedStore = store;
        return store;
      };
      const store = registration
        ? await settleAgentRegistration(registration, openStore)
        : await openStore();
      if (!store) {
        return undefined;
      }
      try {
        assertCurrent();
        // An eager opener has already settled registration and its topology publication.
        if (nativeIdentity) {
          preparationPublished = true;
        }
        return store;
      } catch (error) {
        try {
          await store.close();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Agent open and cleanup failed", {
            cause: cleanupError,
          });
        }
        if (error instanceof AgentDatabaseExecutionAdmissionClosedError) {
          closedOpeningRefusal = error;
        }
        throw error;
      }
    })()
      .catch(async (error: unknown) => {
        openingFailure =
          closedOpeningRefusal !== undefined && error === closedOpeningRefusal
            ? "open-refused"
            : "native";
        if (openingAdmission) {
          const { admission: captured, settled } = openingAdmission;
          const outcome = await settled;
          // Only a settled caller refusal can preserve other logical borrowers.
          // Protocol faults, cleanup aggregates, and uncertain native work retire the whole owner.
          if (
            captured.failure !== undefined &&
            captured.failureSource !== "protocol" &&
            error === captured.failure &&
            outcome.kind !== "unknown" &&
            !captured.committed &&
            captured.cleanupFailures.length === 0
          ) {
            openingFailure = "open-refused";
          }
        }
        throw error;
      })
      .finally(() => {
        openingAdmission = undefined;
        closedOpeningRefusal = undefined;
      });
    const attempt = opening;
    return attempt.then((store) => {
      if (!store && opening === attempt) {
        opening = undefined;
      }
      if (!store && createIfMissing) {
        return open(source, assertCallerCurrent, true, signal);
      }
      return store;
    });
  };
  async function run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    createIfMissing = false,
    signal?: AbortSignal,
    readmitSchema = false,
  ): Promise<T | undefined> {
    const assertOperationCurrent = () => {
      assertCurrent();
      source.assertCurrent();
      assertCallerCurrent?.();
      signal?.throwIfAborted();
    };
    const wasPrepared = preparationPublished;
    // Opening publishes registration before another caller can reuse this generation.
    const store = preparationPublished
      ? openedStore
      : await open(source, assertCallerCurrent, createIfMissing, signal);
    assertOperationCurrent();
    if (!store) {
      return undefined;
    }
    const schema = createIfMissing
      ? getOpenClawAgentDatabaseValidationForTransfer({ agentId, path: pathname })?.schema
      : undefined;
    const requiresReadmission =
      createIfMissing &&
      wasPrepared &&
      (readmitSchema ||
        !schema ||
        Atomics.load(new Int32Array(schema.valid), 0) !== 1 ||
        captureAgentDatabasePreparationJournal(agentId, { env: input.environment }) !== undefined);
    if (!nativeIdentity || requiresReadmission) {
      const registration = captureOpenClawAgentDatabaseRegistration({
        agentId,
        agentPath: pathname,
        admission: context.admission,
        assertPublicationCurrent: context.assertPublicationCurrent,
        onRegistryChange: source.onRegistryChange,
      });
      await settleAgentRegistration(registration, async () => {
        await runSqliteWorkerStoreOperation(
          store,
          (scope) => scope.execute({ type: "database.prepareWrite", input: undefined }, { signal }),
          undefined,
          assertOperationCurrent,
          admission(source, registration, assertCallerCurrent),
        );
        assertCurrent();
        source.assertCurrent();
      });
      preparationPublished = true;
    }
    if (integrityCheckPending) {
      const preparation = captureAgentDatabasePreparationCompletion(agentId, {
        env: input.environment,
      });
      requestOpenClawAgentDatabaseIntegrityCheck({
        path: pathname,
        env: input.environment,
        check: integrityCheckPending,
        ...(integrityCheckPending === "full" && nativeIdentity
          ? {
              release: retainVerification(),
              proof: {
                identity: nativeIdentity.physicalIdentity,
                complete: async (
                  assertVerifierCurrent: () => void,
                  verifierSignal: AbortSignal,
                ) => {
                  if (preparation) {
                    await racePromiseWithAbortSignal(preparation, verifierSignal);
                  }
                  const assert = () => {
                    assertVerifierCurrent();
                    context.admission.assertCurrent();
                    assertCurrent();
                  };
                  const verifierSource: AgentDatabaseRequestExecutionSource = {
                    assertCurrent: assert,
                    createAdmission: (binding) => () => ({
                      nativeLocations: binding.nativeLocations,
                      admission: createSqliteWorkerOperationAdmission((request, grant) => {
                        binding.authorize(request);
                        assert();
                        if (!grant()) {
                          throw new Error("Agent background verification authority expired");
                        }
                      }, binding.attachment),
                    }),
                  };
                  return runOpenClawAgentWorkerWrite(
                    { agentId, path: pathname, env: input.environment },
                    () =>
                      runSqliteWorkerStoreOperation<AgentDatabaseOperations, boolean>(
                        store,
                        (scope) =>
                          scope.execute({ type: "database.recordIntegrity", input: undefined }),
                        undefined,
                        assert,
                        admission(verifierSource),
                      ),
                  );
                },
              },
            }
          : {}),
      });
      integrityCheckPending = undefined;
    }
    return runSqliteWorkerStoreOperation(
      store,
      operation,
      undefined,
      assertOperationCurrent,
      admission(source, undefined, assertCallerCurrent),
    );
  }
  return {
    failure: () =>
      openingFailure ??
      (openedStore && !isSqliteWorkerStoreAvailable(openedStore) ? "native" : undefined),
    isPrepared() {
      assertCurrent();
      return preparationPublished;
    },
    captureClaim() {
      assertCurrent();
      const captured = nativeIdentity;
      if (!captured) {
        throw new Error("Agent database generation has not been admitted");
      }
      return {
        identity: captured.physicalIdentity,
        incarnation: captured.incarnation,
        assertCurrent() {
          assertCurrent();
          if (nativeIdentity !== captured) {
            throw new Error("Agent database generation changed");
          }
        },
      };
    },
    run,
    close() {
      retiring = true;
      closing ??= (async () => {
        const errors: unknown[] = [];
        let storeClosed = false;
        if (opening) {
          try {
            await opening.then(
              async (store) => {
                await store?.close();
                storeClosed = store !== undefined;
              },
              () =>
                openedStore
                  ? openedStore.close()
                  : closeUnclaimedSharedStateSqliteWorkers(pathname),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (nativeStopped && lease) {
          try {
            await nativeStopped;
            assertCleanupOwned();
            // The backend publishes this receipt only after native close and lease release.
            // A closed client or exited Worker alone still needs orphan recovery.
            if (
              storeClosed &&
              readAgentDatabaseClosedReceipt(readCloseReceipt?.(), nativeIdentity, lease)
            ) {
              assertExistingDatabaseIdentity(lease.sharedStatePath, lease.sharedStateIdentity);
            } else {
              await cleanupRetiredAgentDatabaseLease({
                context,
                stopped: nativeStopped,
                assertOwned: assertCleanupOwned,
                lease,
              });
            }
          } catch (error) {
            errors.push(error);
          }
        }
        throwSqliteLifecycleErrors(errors, "Agent native close and lease cleanup failed");
        publishAgentDatabaseCloseCheckpoint(
          pathname,
          readAgentDatabaseClosedReceipt(readCloseReceipt?.(), nativeIdentity, lease),
          assertCleanupOwned,
        );
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}
