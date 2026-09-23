import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-coordinator.js";
import { publishSqliteWalCheckpointObservation } from "../infra/sqlite-wal-checkpoint.js";
import type { SqliteWorkerCloseReceipt } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  closeUnclaimedSharedStateSqliteWorkers,
  isSqliteWorkerStoreAvailable,
  openAgentDatabaseSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import { captureAgentDatabasePreparationJournal } from "./agent-database-admission.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import { captureOpenClawAgentDatabaseRegistration } from "./openclaw-agent-db-registry-listing.js";
import {
  captureOpenClawAgentDatabaseValidationTransfer,
  getOpenClawAgentDatabaseValidationForTransfer,
} from "./openclaw-agent-db-validation-cache.js";
import { cleanupRetiredAgentDatabaseLease } from "./openclaw-agent-execution-cleanup.js";
import type {
  AgentDatabaseExecutionIdentity,
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseExecutionOpen,
  AgentDatabaseRequestExecutionSource,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import { requestOpenClawAgentDatabaseQuickCheck } from "./openclaw-database-verify.js";
import { publishOpenClawStateDatabaseWorkerAdmission } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type Store = SqliteWorkerStore<AgentDatabaseOperations>;
type Registration = ReturnType<typeof captureOpenClawAgentDatabaseRegistration>;

async function settleAgentRegistration<T>(
  registration: Registration,
  operation: () => Promise<T>,
): Promise<T> {
  let result: Result<T, unknown>;
  try {
    result = { ok: true, value: await operation() };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    registration.finish();
  } catch (error) {
    if (!result.ok) {
      throw createSqliteLifecycleAggregateError(
        [result.error, error],
        "Agent open and registration publication failed",
        result.error,
      );
    }
    throw error;
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export type AgentDatabaseExecutionScope = Pick<Store, "execute">;
export type AgentDatabaseNativeGeneration = {
  failed(): boolean;
  run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    createIfMissing?: boolean,
  ): Promise<T | undefined>;
  close(): Promise<void>;
};

/** A logical execution owner can replace this generation only after its native close settles. */
export function createAgentDatabaseNativeGeneration(
  agentId: string,
  pathname: string,
  context: OpenClawStateWorkerContext,
  assertLogicalCurrent: () => void,
  assertCleanupOwned: () => void,
  expectedIdentity: AgentDatabaseExecutionFileIdentity | undefined,
  acceptFileIdentity: (identity: AgentDatabaseExecutionFileIdentity) => void,
  creatingIdentity?: DatabasePathIdentity,
): AgentDatabaseNativeGeneration {
  const input: AgentDatabaseExecutionOpen = {
    leaseId: randomUUID(),
    agentId,
    databasePath: pathname,
    stateDatabasePath: context.admission.databasePath,
    environment: context.environment,
    ...(expectedIdentity ? { expectedIdentity } : {}),
    ...(creatingIdentity ? { creatingIdentity } : {}),
  };
  let retiring = false;
  let opening: Promise<Store | undefined> | undefined;
  let openedStore: Store | undefined;
  let openingFailed = false;
  let closing: Promise<void> | undefined;
  let nativeIdentity: AgentDatabaseExecutionIdentity | undefined;
  let nativeStopped: Promise<void> | undefined;
  let readCloseReceipt: (() => SqliteWorkerCloseReceipt | undefined) | undefined;
  let lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
  let quickCheckPending = false;
  let receiveValidation:
    | ReturnType<typeof captureOpenClawAgentDatabaseValidationTransfer>
    | undefined;

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
      registration?: Registration,
      assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    ): SqliteWorkerAdmissionFactory =>
    (operation) => {
      const assertPreparationJournal = captureAgentDatabasePreparationJournal(agentId, {
        env: context.environment,
      });
      const nativeLocations = [
        pathname,
        ...(nativeIdentity ? [nativeIdentity.nativeLocation] : []),
        context.admission.databasePath,
        context.admission.identity.canonicalPath,
      ];
      const assertSourceCurrent = (identity?: AgentDatabaseExecutionIdentity) => {
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
      const authorizeNative = (
        request: SqliteWorkerAdmissionRequest,
      ): AgentDatabaseExecutionIdentity | undefined => {
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
          return undefined;
        }
        assertCurrent();
        if (!nativeIdentity || creatingIdentity) {
          assertCallerCurrent?.();
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
            receiveValidation = captureOpenClawAgentDatabaseValidationTransfer({
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
          facts.kind === "agent-integrity-cached"
        ) {
          assertSourceCurrent();
          if (!lease || !isDeepStrictEqual(facts.lease, lease)) {
            throw new Error("Agent integrity notice differs from its captured native lease");
          }
          quickCheckPending = true;
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
          const receivedIdentity: AgentDatabaseExecutionIdentity =
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
      return source.createAdmission({
        attachment: {
          kind: "agent-execution",
          startupJournal: assertPreparationJournal !== undefined,
        },
        nativeLocations,
        assertCurrent,
        authorize(request) {
          const identity = authorizeNative(request);
          if (request.stage === "open" && registration) {
            assertSourceCurrent();
            registration.begin();
          }
          if (
            request.stage === "prepare" &&
            identity &&
            receiveValidation &&
            isRecord(request.facts)
          ) {
            assertSourceCurrent(identity);
            receiveValidation(identity.physicalIdentity, request.facts.validation);
            receiveValidation = undefined;
          }
          assertSourceCurrent(identity);
        },
      })(operation);
    };
  const open = (
    source: AgentDatabaseRequestExecutionSource,
    assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    createIfMissing = false,
  ): Promise<Store | undefined> => {
    assertCurrent();
    source.assertCurrent();
    assertCallerCurrent?.();
    opening ??= (async () => {
      const registration = createIfMissing
        ? captureOpenClawAgentDatabaseRegistration({
            agentId,
            agentPath: pathname,
            admission: context.admission,
            onRegistryChange: source.onRegistryChange,
          })
        : undefined;
      const openStore = () =>
        openAgentDatabaseSqliteWorkerStore<AgentDatabaseOperations>(
          {
            moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.agentDatabaseExecution),
            databasePath: pathname,
            input,
            existingOnly: !createIfMissing,
          },
          {
            stateContext: context,
            stateDatabasePath: context.admission.databasePath,
            assertCurrent,
            createAdmission: admission(source, registration, assertCallerCurrent),
            onNativeStopped: (stopped, readReceipt) => {
              nativeStopped = stopped;
              readCloseReceipt = readReceipt;
            },
          },
        );
      const store = registration
        ? await settleAgentRegistration(registration, openStore)
        : await openStore();
      if (!store) {
        return undefined;
      }
      openedStore = store;
      try {
        assertCurrent();
        return store;
      } catch (error) {
        try {
          await store.close();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Agent open and cleanup failed", {
            cause: cleanupError,
          });
        }
        throw error;
      }
    })().catch((error: unknown) => {
      openingFailed = true;
      throw error;
    });
    const attempt = opening;
    return attempt.then((store) => {
      if (!store && opening === attempt) {
        opening = undefined;
      }
      if (!store && createIfMissing) {
        return open(source, assertCallerCurrent, true);
      }
      return store;
    });
  };
  async function run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    createIfMissing = false,
  ): Promise<T | undefined> {
    const store = openedStore ?? (await open(source, assertCallerCurrent, createIfMissing));
    assertCurrent();
    source.assertCurrent();
    assertCurrent();
    assertCallerCurrent?.();
    if (!store) {
      return undefined;
    }
    if (!nativeIdentity) {
      const registration = captureOpenClawAgentDatabaseRegistration({
        agentId,
        agentPath: pathname,
        admission: context.admission,
        onRegistryChange: source.onRegistryChange,
      });
      await settleAgentRegistration(registration, async () => {
        await runSqliteWorkerStoreOperation(
          store,
          (scope) => scope.execute({ type: "database.prepareWrite", input: undefined }),
          undefined,
          assertCurrent,
          admission(source, registration, assertCallerCurrent),
        );
        assertCurrent();
        source.assertCurrent();
      });
    }
    if (quickCheckPending) {
      quickCheckPending = false;
      requestOpenClawAgentDatabaseQuickCheck({ path: pathname, env: input.environment });
    }
    return runSqliteWorkerStoreOperation(
      store,
      operation,
      undefined,
      assertCurrent,
      admission(source, undefined, assertCallerCurrent),
    );
  }
  const publishCloseCheckpoint = () => {
    const receipt = readCloseReceipt?.();
    if (
      !receipt ||
      !nativeIdentity ||
      !lease ||
      receipt.incarnation !== nativeIdentity.incarnation ||
      receipt.identity.key !== `file:${nativeIdentity.physicalIdentity}` ||
      receipt.identity.canonicalPath !== nativeIdentity.nativeLocation
    ) {
      return;
    }
    try {
      // Cleanup retains custody after ordinary admission is revoked during shutdown.
      assertCleanupOwned();
      assertExistingDatabaseIdentity(pathname, receipt.identity.key);
      assertExistingDatabaseIdentity(nativeIdentity.nativeLocation, receipt.identity.key);
      assertExistingDatabaseIdentity(lease.sharedStatePath, lease.sharedStateIdentity);
      publishSqliteWalCheckpointObservation(pathname, receipt.checkpoint);
    } catch {
      // A stale diagnostic must not clear another generation's budget or fail native cleanup.
    }
  };
  return {
    failed: () =>
      openingFailed || Boolean(openedStore && !isSqliteWorkerStoreAvailable(openedStore)),
    run,
    close() {
      retiring = true;
      closing ??= (async () => {
        const errors: unknown[] = [];
        if (opening) {
          try {
            await opening.then(
              (store) => store?.close(),
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
            await cleanupRetiredAgentDatabaseLease({
              context,
              stopped: nativeStopped,
              assertOwned: assertCleanupOwned,
              lease,
            });
          } catch (error) {
            errors.push(error);
          }
        }
        throwSqliteLifecycleErrors(errors, "Agent native close and lease cleanup failed");
        publishCloseCheckpoint();
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}
