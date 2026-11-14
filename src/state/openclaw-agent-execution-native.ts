import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import type { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import {
  bindSqliteWorkerExecutionAuthority,
  type SqliteWorkerAdmissionFactory,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  isSqliteWorkerStoreAvailable,
  openAgentDatabaseSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
} from "../infra/sqlite-worker-store.js";
import { recordWorkerMessage } from "../infra/worker-message-metrics.js";
import {
  AgentDatabaseExecutionAdmissionClosedError,
  AgentDatabaseSchemaAdmissionChangedError,
} from "./agent-database-admission-error.js";
import {
  captureAgentDatabasePreparationJournal,
  recordAgentDatabaseStartupFtsRepair,
} from "./agent-database-admission.js";
import { captureAgentDatabaseStartupVerification } from "./agent-database-startup-integrity.js";
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
  hasRevokedOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
  retireReplacedAgentValidation,
} from "./openclaw-agent-db-validation-cache.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { AgentDatabaseExecutionLifetime } from "./openclaw-agent-execution-authority.js";
import {
  closeAgentDatabaseNativeGeneration,
  readAgentDatabaseClosedReceipt,
} from "./openclaw-agent-execution-cleanup.js";
import type {
  AgentDatabaseFileExecutionIdentity,
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseFileExecutionOpen,
  AgentDatabaseExecutionScope,
  AgentDatabaseNativeGeneration,
  AgentDatabaseNativeStore as Store,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import {
  createSharedAgentDatabasePreparation,
  receiveAgentDatabaseSharedOwnerReceipt,
} from "./openclaw-agent-execution-preparation.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** A logical execution owner can replace this generation only after its native close settles. */
export function createAgentDatabaseNativeGeneration(
  agentId: string,
  pathname: string,
  context: OpenClawStateWorkerContext,
  processOwner: ReturnType<typeof captureGatewayStateOwner>,
  logicalLifetime: Int32Array<SharedArrayBuffer>,
  assertLogicalCurrent: () => void,
  assertCleanupOwned: () => void,
  expectedIdentity: AgentDatabaseExecutionFileIdentity | undefined,
  acceptFileIdentity: (identity: AgentDatabaseExecutionFileIdentity) => void,
  onTerminal: (reason: Error) => void,
  creatingIdentity?: DatabasePathIdentity,
  creationClaim?: AgentDatabaseFileExecutionOpen["creationClaim"],
  startupPreparation = false,
  observePreparedIntegrity?: () => void,
  initialIdentity?: DatabasePathIdentity,
): AgentDatabaseNativeGeneration {
  const inPreparation = AsyncLocalStorage.snapshot();
  const validationSource = { agentId, path: pathname, canonicalPath: pathname };
  const startupSignal = startupPreparation ? resolveSqliteInspectionSignal() : undefined;
  const startupCancellation = startupSignal
    ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    : undefined;
  const cancelStartup = () => {
    if (startupCancellation) {
      Atomics.store(startupCancellation, 0, 1);
      Atomics.notify(startupCancellation, 0);
    }
  };
  const startupAbort = startupSignal && addAbortListener(startupSignal, cancelStartup);
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
  const lifetime = new AgentDatabaseExecutionLifetime();
  let opening: Promise<Store | undefined> | undefined;
  let openedStore: Store | undefined;
  let openingFailure: "open-refused" | "native" | undefined;
  let closedOpeningRefusal: Error | undefined;
  let openingAdmission:
    | {
        admission: ReturnType<SqliteWorkerAdmissionFactory>["admission"];
        settled: Parameters<SqliteWorkerAdmissionFactory>[0]["settled"];
      }
    | undefined;
  let closing: Promise<void> | undefined;
  let nativeIdentity: AgentDatabaseFileExecutionIdentity | undefined;
  let nativeStopped: Promise<void> | undefined;
  let readCloseReceipt: (() => Parameters<typeof readAgentDatabaseClosedReceipt>[0]) | undefined;
  let readOpenRefused: (() => boolean) | undefined;
  let lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
  let preparationPublished = false;
  let nativeLossReason: Error | undefined;
  const sharedPreparation = createSharedAgentDatabasePreparation(() => assertCurrent());

  // Terminal readers belong to this generation, not its initiating request.
  const onNativeStopped: NonNullable<
    Parameters<typeof openAgentDatabaseSqliteWorkerStore>[1]["onNativeStopped"]
  > = (stopped, readReceipt, readRefused) => {
    nativeStopped = stopped;
    readCloseReceipt = readReceipt;
    readOpenRefused = readRefused;
  };

  // The actor retains this observer; keep it outside the opening caller's scope.
  const onNativeLost = (reason: Error) => {
    nativeLossReason ??= reason;
    lifetime.retire();
    // Before the lease handoff this generation has borrowed no validation.
    if (lease) {
      invalidateOpenClawAgentDatabaseValidation(validationSource);
    }
    // Failed opening admission can be ordinary lock contention; run classifies it after settlement.
    if (preparationPublished) {
      onTerminal(reason);
    }
  };
  const assertCurrent = () => {
    assertLogicalCurrent();
    if (openedStore && !isSqliteWorkerStoreAvailable(openedStore)) {
      throw (
        nativeLossReason ??
        new SqliteWorkerError("Database unavailable. Check history, then retry.", "unavailable")
      );
    }
    if (!lifetime.open) {
      throw new Error("Agent native generation is retiring");
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
        ? captureOpenClawAgentDatabaseAdmissionPublication(validationSource)
        : undefined;
      if (registration) {
        registration.nativeSettlement = operation.settled;
      }
      const assertPreparationJournal = captureAgentDatabasePreparationJournal(agentId, {
        env: context.environment,
      });
      const assertBackgroundIntegrity = assertPreparationJournal
        ? captureAgentDatabaseStartupVerification(
            pathname,
            context.environment,
            nativeIdentity ?? expectedIdentity,
          )
        : undefined;
      const nativeLocations = [
        pathname,
        ...(nativeIdentity ? [nativeIdentity.nativeLocation] : []),
        context.admission.databasePath,
        context.admission.identity.canonicalPath,
      ];
      const assertSourceCurrent = (identity?: AgentDatabaseFileExecutionIdentity) => {
        source.assertCurrent();
        assertCurrent();
        assertBackgroundIntegrity?.();
        // The reference checks its captured constraints; this owner checks the path last.
        assertCallerCurrent?.(identity);
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
          if (!registration || !lease || !isRecord(received)) {
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
        assertCurrent();
        cleanup?.assertCurrent();
        if (request.stage === "prepare" && isRecord(facts) && facts.kind === "agent-startup-fts") {
          assertSourceCurrent();
          if (
            !assertPreparationJournal ||
            !lease ||
            (facts.message !== undefined && typeof facts.message !== "string")
          ) {
            throw new Error("FTS repair requires live Gateway startup admission");
          }
          recordAgentDatabaseStartupFtsRepair(
            [expectedIdentity?.physicalIdentity ?? pathname, expectedIdentity?.birthtime].join(":"),
            context.admission.databasePath,
            facts.message,
          );
          return undefined;
        }
        if (!nativeIdentity || creatingIdentity) {
          assertCallerCurrent?.();
        }
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          facts.kind === "agent-registration-start"
        ) {
          assertSourceCurrent();
          if (!registration || !lease) {
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
            lease = receiveAgentDatabaseSharedOwnerReceipt(
              facts,
              context.admission,
              input.leaseId,
              validationSource,
            );
            receiveValidation = captureOpenClawAgentDatabaseAdmissionPublication(validationSource);
            const preparation = {
              integrityRevoked: hasRevokedOpenClawAgentDatabaseValidation(validationSource),
              validation: getOpenClawAgentDatabaseValidationForTransfer(validationSource),
            };
            facts.validationPort.postMessage(preparation, []);
            recordWorkerMessage("admission", "to_worker");
          } finally {
            facts.validationPort.close();
          }
          return undefined;
        }
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          (facts.kind === "agent-open-resume" || facts.kind === "agent-validation-start")
        ) {
          assertSourceCurrent();
          if (!lease) {
            throw new Error("Agent open notice differs from its captured native lease");
          }
          if (facts.kind === "agent-validation-start") {
            // Lease cleanup can revoke borrowed proof. Capture before verification,
            // so a later revocation still rejects the resulting publication.
            receiveValidation = captureOpenClawAgentDatabaseAdmissionPublication(validationSource);
          }
          return undefined;
        }
        if (request.stage !== "open") {
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
          readCustody: source.readCustody,
          workspaceEvidence: source.workspaceEvidence,
          startupJournal: assertPreparationJournal !== undefined,
          // Startup repair without a background verifier retains foreground verification.
          startupIntegrityRequired: Boolean(assertPreparationJournal && !assertBackgroundIntegrity),
          ...(startupCancellation ? { startupCancellation } : {}),
          ...(cleanup ? { deletion: cleanup.guard } : {}),
        },
        nativeLocations,
        assertCurrent,
        authorize(request) {
          if (
            request.stage === "prepare" &&
            isRecord(request.facts) &&
            request.facts.kind === "agent-registration-committed"
          ) {
            // observeNative records this past COMMIT; subsequent work still requires live authority.
            return;
          }
          const identity = authorizeNative(request);
          if (request.stage === "open" && registration) {
            assertSourceCurrent();
            const creating =
              !nativeIdentity &&
              !expectedIdentity &&
              isRecord(request.facts) &&
              request.facts.creating === true;
            if (creating) {
              if (!lease && getOpenClawAgentDatabaseValidationForTransfer(validationSource)) {
                // Absence ends retained proof even if Linux reuses the inode. Later open
                // checkpoints must preserve the publication captured by the lease handoff.
                invalidateOpenClawAgentDatabaseValidation(validationSource);
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
      if (preparationPublished && nativeIdentity && !creatingIdentity && !registration) {
        bindSqliteWorkerExecutionAuthority(captured.admission, {
          logical: logicalLifetime,
          native: lifetime.state,
          physicalIdentity: nativeIdentity.physicalIdentity,
          incarnation: nativeIdentity.incarnation,
          ...(nativeIdentity.birthtime !== undefined
            ? { birthtime: nativeIdentity.birthtime }
            : {}),
        });
      }
      captured.admission.observeRequests(observeNative);
      return captured;
    };
  const captureOpeningAdmission: typeof admission =
    (...args) =>
    (operation) => {
      const captured = admission(...args)(operation);
      openingAdmission = { admission: captured.admission, settled: operation.settled };
      return captured;
    };
  const captureRegistration = (source: AgentDatabaseRequestExecutionSource) => {
    const file = nativeIdentity ?? expectedIdentity;
    return captureOpenClawAgentDatabaseRegistration({
      agentId,
      agentPath: pathname,
      capturedIdentity: file
        ? {
            key: `file:${file.physicalIdentity}`,
            canonicalPath: file.nativeLocation,
            birthtime: file.birthtime,
          }
        : (creatingIdentity ?? initialIdentity),
      admission: context.admission,
      assertPublicationCurrent: context.assertPublicationCurrent,
      onRegistryChange: source.onRegistryChange,
    });
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
    if (!opening) {
      const finishPreparation = sharedPreparation.retain();
      const finishNativeOpen = sharedPreparation.beginNativeOpen();
      opening = (async () => {
        retireReplacedAgentValidation(agentId, pathname, expectedIdentity);
        // Existing physical files share preparation. First-use creation retains its caller's claim.
        const preparingShared = expectedIdentity !== undefined;
        const registration =
          createIfMissing || preparingShared
            ? captureRegistration(preparingShared ? sharedPreparation.source : source)
            : undefined;
        const openStore = async () => {
          const assertOpening = () => {
            assertCurrent();
            source.assertCurrent();
            assertCallerCurrent?.();
            signal?.throwIfAborted();
          };
          // Keep the native owner reachable if registration publication fails after open.
          openedStore = await openAgentDatabaseSqliteWorkerStore<AgentDatabaseOperations>(
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.agentDatabaseExecution),
              databasePath: pathname,
              input,
              existingOnly: preparingShared || !createIfMissing,
            },
            {
              startupPreparation,
              stateContext: context,
              stateDatabasePath: context.admission.databasePath,
              assertCurrent: preparingShared ? assertCurrent : assertOpening,
              signal: preparingShared ? undefined : signal,
              createAdmission: captureOpeningAdmission(
                preparingShared ? sharedPreparation.source : source,
                registration,
                preparingShared ? undefined : assertCallerCurrent,
              ),
              onNativeStopped,
              onNativeLost,
            },
          );
          const store = openedStore;
          finishNativeOpen();
          if (store && preparingShared && !nativeIdentity) {
            await inPreparation(() =>
              runSqliteWorkerStoreOperation(
                store,
                (scope) => scope.execute({ type: "database.prepareWrite", input: undefined }),
                undefined,
                assertCurrent,
                captureOpeningAdmission(sharedPreparation.source, registration),
              ),
            );
          }
          return openedStore;
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
          preparationPublished ||= nativeIdentity !== undefined;
          observePreparedIntegrity?.();
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
            error instanceof AgentDatabaseSchemaAdmissionChangedError ||
            (closedOpeningRefusal !== undefined && error === closedOpeningRefusal)
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
          if (lease) {
            try {
              await openClawStateDatabaseCache.reconcileFailedWorkerAdmission(context.admission);
            } catch {
              // Replacement revokes the captured admission; retain the original opening refusal.
            }
          }
          throw error;
        })
        .finally(() => {
          openingAdmission = undefined;
          closedOpeningRefusal = undefined;
          finishNativeOpen();
          finishPreparation();
        });
    }
    const attempt = opening;
    return attempt.then((store) => {
      if (!store && opening === attempt) {
        opening = undefined;
      }
      if (!store && createIfMissing && !expectedIdentity) {
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
  ): Promise<T | undefined> {
    const assertOperationCurrent = () => {
      assertCurrent();
      source.assertCurrent();
      assertCallerCurrent?.();
      signal?.throwIfAborted();
    };
    const finishPreparation = preparationPublished ? undefined : sharedPreparation.retain();
    const publication = finishPreparation
      ? sharedPreparation.follow(source, assertOperationCurrent)
      : undefined;
    let preparedStore: Store;
    try {
      // Opening publishes registration before another caller can reuse this generation.
      const store = preparationPublished
        ? openedStore
        : await racePromiseWithAbortSignal(
            open(source, assertCallerCurrent, createIfMissing, signal),
            signal,
            (aborted) => aborted.reason,
          );
      publication?.assertPublished();
      assertOperationCurrent();
      if (!store) {
        if (createIfMissing && expectedIdentity) {
          throw new Error("Captured agent database file disappeared before writable preparation");
        }
        return undefined;
      }
      const schema = createIfMissing
        ? getOpenClawAgentDatabaseValidationForTransfer(validationSource)?.schema
        : undefined;
      // Explicitly invalidated proof must be prepared in the worker before host adoption.
      if (
        !nativeIdentity ||
        (createIfMissing &&
          preparationPublished &&
          (!schema || Atomics.load(new Int32Array(schema.valid), 0) !== 1))
      ) {
        const registration = captureRegistration(source);
        await settleAgentRegistration(registration, async () => {
          await runSqliteWorkerStoreOperation(
            store,
            (scope) =>
              scope.execute({ type: "database.prepareWrite", input: undefined }, { signal }),
            undefined,
            assertOperationCurrent,
            admission(source, registration, assertCallerCurrent),
          );
          assertCurrent();
          source.assertCurrent();
        });
        preparationPublished = true;
        observePreparedIntegrity?.();
      }
      preparedStore = store;
    } finally {
      publication?.release();
      finishPreparation?.();
    }
    return runSqliteWorkerStoreOperation(
      preparedStore,
      operation,
      undefined,
      assertOperationCurrent,
      admission(source, undefined, assertCallerCurrent),
    );
  }
  return {
    failure: () =>
      openingFailure ??
      (openedStore && !isSqliteWorkerStoreAvailable(openedStore)
        ? preparationPublished
          ? "lost"
          : "native"
        : undefined),
    isPrepared() {
      assertCurrent();
      return preparationPublished;
    },
    getPendingNativeOpen: sharedPreparation.getPendingNativeOpen,
    getPendingPreparation: sharedPreparation.getPendingPreparation,
    captureClaim(assertBorrowed) {
      assertCurrent();
      const captured = nativeIdentity;
      if (!captured) {
        throw new Error("Agent database generation has not been admitted");
      }
      return {
        identity: captured.physicalIdentity,
        incarnation: captured.incarnation,
        authority: {
          logical: logicalLifetime,
          native: lifetime.state,
          physicalIdentity: captured.physicalIdentity,
          incarnation: captured.incarnation,
          birthtime: captured.birthtime,
        },
        assertCurrent() {
          assertBorrowed();
          assertCurrent();
        },
      };
    },
    run,
    close() {
      lifetime.retire();
      cancelStartup();
      startupAbort?.[Symbol.dispose]();
      closing ??= closeAgentDatabaseNativeGeneration({
        pathname,
        context,
        processOwner,
        opening,
        readOpenedStore: () => openedStore,
        assertCleanupOwned,
        readRetirement: () => ({
          stopped: nativeStopped,
          lease,
          readOpenRefused,
          closed: readAgentDatabaseClosedReceipt(readCloseReceipt?.(), nativeIdentity, lease),
        }),
      }).catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}
