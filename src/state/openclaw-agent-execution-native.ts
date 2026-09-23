import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { publishSqliteWalCheckpointObservation } from "../infra/sqlite-wal-checkpoint.js";
import type { SqliteWorkerCloseReceipt } from "../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
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
  runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: () => void,
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
): AgentDatabaseNativeGeneration {
  const input: AgentDatabaseExecutionOpen = {
    leaseId: randomUUID(),
    agentId,
    databasePath: pathname,
    stateDatabasePath: context.admission.databasePath,
    environment: context.environment,
    ...(expectedIdentity ? { expectedIdentity } : {}),
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
      assertCallerCurrent?: () => void,
    ): SqliteWorkerAdmissionFactory =>
    (operation) => {
      const nativeLocations = [
        pathname,
        ...(nativeIdentity ? [nativeIdentity.nativeLocation] : []),
        context.admission.databasePath,
        context.admission.identity.canonicalPath,
      ];
      const authorizeNative = (request: SqliteWorkerAdmissionRequest): boolean => {
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
          return true;
        }
        assertCurrent();
        assertCallerCurrent?.();
        if (request.stage === "prepare" && isRecord(facts) && facts.kind === "shared-owner") {
          if (!(facts.validationPort instanceof MessagePort)) {
            throw new Error("Agent worker lost its validation handoff port");
          }
          try {
            source.assertCurrent();
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
          return true;
        }
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          facts.kind === "agent-integrity-cached"
        ) {
          source.assertCurrent();
          if (!lease || !isDeepStrictEqual(facts.lease, lease)) {
            throw new Error("Agent integrity notice differs from its captured native lease");
          }
          quickCheckPending = true;
          return true;
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
            typeof received.incarnation !== "string" ||
            typeof received.nativeLocation !== "string" ||
            (nativeIdentity && !isDeepStrictEqual(received, nativeIdentity))
          ) {
            throw new Error("Agent database operation belongs to another native owner");
          }
          const receivedIdentity: AgentDatabaseExecutionIdentity = {
            kind: "file",
            physicalIdentity: received.physicalIdentity,
            incarnation: received.incarnation,
            nativeLocation: received.nativeLocation,
          };
          assertExistingDatabaseIdentity(pathname, `file:${receivedIdentity.physicalIdentity}`);
          if (
            expectedIdentity &&
            receivedIdentity.physicalIdentity !== expectedIdentity.physicalIdentity
          ) {
            throw new Error("Agent database operation differs from its expected physical file");
          }
          acceptFileIdentity({
            kind: "file",
            physicalIdentity: receivedIdentity.physicalIdentity,
            nativeLocation: receivedIdentity.nativeLocation,
          });
          assertCallerCurrent?.();
          nativeIdentity ??= receivedIdentity;
        }
        return false;
      };
      const prepareGrant = (request: SqliteWorkerAdmissionRequest) => {
        assertCurrent();
        assertCallerCurrent?.();
        if (request.stage === "open") {
          registration?.begin();
        }
      };
      return source.createAdmission({
        nativeLocations,
        assertCurrent,
        authorize(request) {
          if (authorizeNative(request)) {
            return;
          }
          source.assertCurrent();
          prepareGrant(request);
          if (request.stage === "prepare" && nativeIdentity && isRecord(request.facts)) {
            receiveValidation?.(nativeIdentity.physicalIdentity, request.facts.validation);
            receiveValidation = undefined;
          }
        },
      })(operation);
    };
  const open = (
    source: AgentDatabaseRequestExecutionSource,
    assertCallerCurrent?: () => void,
  ): Promise<Store | undefined> => {
    assertCurrent();
    source.assertCurrent();
    assertCallerCurrent?.();
    opening ??= (async () => {
      const store = await openAgentDatabaseSqliteWorkerStore<AgentDatabaseOperations>(
        {
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.agentDatabaseExecution),
          databasePath: pathname,
          input,
          existingOnly: true,
        },
        {
          stateContext: context,
          stateDatabasePath: context.admission.databasePath,
          assertCurrent,
          createAdmission: admission(source, undefined, assertCallerCurrent),
          onNativeStopped: (stopped, readReceipt) => {
            nativeStopped = stopped;
            readCloseReceipt = readReceipt;
          },
        },
      );
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
      return store;
    });
  };
  async function runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: () => void,
  ): Promise<T | undefined> {
    const store = await open(source, assertCallerCurrent);
    assertCurrent();
    assertCallerCurrent?.();
    source.assertCurrent();
    if (!store) {
      return undefined;
    }
    if (!nativeIdentity) {
      const registration = captureOpenClawAgentDatabaseRegistration({
        agentId,
        agentPath: pathname,
        admission: context.admission,
      });
      await settleAgentRegistration(registration, async () => {
        await runSqliteWorkerStoreOperation(
          store,
          (scope) => scope.execute({ type: "database.prepareWrite", input: undefined }),
          context,
          assertCurrent,
          admission(source, registration, assertCallerCurrent),
        );
        assertCurrent();
        source.assertCurrent();
      });
      if (quickCheckPending) {
        quickCheckPending = false;
        requestOpenClawAgentDatabaseQuickCheck({ path: pathname, env: input.environment });
      }
    }
    return runSqliteWorkerStoreOperation(
      store,
      operation,
      context,
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
    runExisting: (source, operation, assertCallerCurrent) =>
      runExisting(source, operation, assertCallerCurrent),
    close() {
      retiring = true;
      closing ??= (async () => {
        const errors: unknown[] = [];
        if (opening) {
          try {
            await opening.then(
              (store) => store?.close(),
              () => closeUnclaimedSharedStateSqliteWorkers(pathname),
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
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "Agent native close and lease cleanup failed", {
            cause: errors[0],
          });
        }
        publishCloseCheckpoint();
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}
