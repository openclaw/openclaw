import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import {
  createSqliteWorkerWriteAdmission,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import type { OpenClawStateLeaseLifecycleOperations } from "./openclaw-state-lease-context.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import { startOpenClawStateLeaseTimer } from "./openclaw-state-lease-heartbeat.js";
import {
  resolveLeaseDatabasePath,
  type OpenClawStateLeaseDatabase,
} from "./openclaw-state-lease-storage.js";
import type {
  createOpenClawStateLeaseWorkerOwner,
  WorkerLeaseScope,
} from "./openclaw-state-lease-worker-owner.js";
import type {
  OpenClawStateLeaseAcquisition,
  OpenClawStateLeaseIdentity,
} from "./openclaw-state-lease.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

export async function acquireLease(
  database: OpenClawStateLeaseDatabase,
  input: {
    identity: OpenClawStateLeaseIdentity;
    leaseMs: number;
    operationLabel: string;
    processBound?: boolean;
  },
  assertCurrent: () => void,
  signal?: AbortSignal,
) {
  if (database.options?.readOnly) {
    throw new Error("State lease acquisition requires writable storage");
  }
  if (database.schemaPolicy === "existing" && database.options?.database) {
    throw new Error("Existing-state writes require their own tracked writable connection.");
  }
  const opened =
    database.schemaPolicy === "existing" ? undefined : openOpenClawStateDatabase(database.options);
  const context = captureOpenClawStateWorkerContext({
    ...database.options,
    path: opened?.path ?? resolveLeaseDatabasePath(database),
  });
  const assertAdmission = () => {
    context.admission.assertCurrent();
    assertCurrent();
    // The worker cannot join a transaction held by the caller's verification handle.
    if (opened?.db.isTransaction) {
      throw new OpenClawStateLeaseError("State lease acquisition requires no active transaction", {
        code: "OPENCLAW_STATE_LEASE_INVALID_INPUT",
      });
    }
  };
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
  assertAdmission();
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute(
        {
          type: "stateLease.acquire",
          input: { ...input, schemaPolicy: database.schemaPolicy },
        },
        { signal },
      ),
    {
      existingOnly: database.schemaPolicy === "existing",
      assertCurrent: assertAdmission,
      createAdmission: createSqliteWorkerWriteAdmission(assertAdmission, [
        context.admission.databasePath,
      ]),
    },
  );
  if (!result) {
    throw new Error("State lease acquisition requires an existing database");
  }
  return result;
}

type LeaseWorkerOwner = ReturnType<typeof createOpenClawStateLeaseWorkerOwner>;
type LeaseWorkerOperation<T> = (
  scope: Pick<SqliteWorkerStore<OpenClawStateLeaseLifecycleOperations>, "execute">,
  identity: OpenClawStateLeaseIdentity,
) => Promise<T>;

/** Keep this importer's admission and release code available across package replacement. */
export async function prepareOpenClawStateLeaseStorageRuntime(): Promise<void> {
  await Promise.all([
    import("./openclaw-state-worker-store.js"),
    import("../infra/sqlite-worker-identity.js"),
    import("../infra/sqlite-worker-store.js"),
  ]);
}

function admittedWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: LeaseWorkerOperation<T>,
) {
  return async (admission: WorkerLeaseScope): Promise<T> => {
    const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
    return runOpenClawStateWorkerOperation(
      context,
      (scope) => operation(scope, admission.identity),
      { assertCurrent: admission.assertCurrent, createAdmission: admission.createAdmission },
    );
  };
}

/** Preserve the original admission, maintenance scope and coordinator runtime. */
export function createOpenClawStateLeaseWorkerStorage(
  context: OpenClawStateWorkerContext,
  processBound = false,
) {
  const storage = {
    path: context.admission.databasePath,
    assertCurrent() {
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
    },
    async withRetainedStartup<T>(
      operation: (startupContext: OpenClawStateWorkerContext) => Promise<T>,
      assertCurrent: () => void,
    ): Promise<T> {
      assertCurrent();
      const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
      return runOpenClawStateWorkerOperation(context, () => operation(context), { assertCurrent });
    },
    acquire(
      owner: LeaseWorkerOwner,
      leaseMs: number,
      operationLabel: string,
      signal?: AbortSignal,
      observeExpiry = false,
    ): Promise<OpenClawStateLeaseAcquisition> {
      return owner.runLifecycle(
        "acquire",
        admittedWorkerOperation(context, (scope, identity) =>
          scope.execute(
            {
              type: "stateLease.acquire",
              input: {
                identity,
                leaseMs,
                operationLabel,
                processBound,
                ...(observeExpiry ? { observeExpiry: true as const } : {}),
              },
            },
            { signal },
          ),
        ),
      );
    },
    verify(owner: LeaseWorkerOwner, signal?: AbortSignal): Promise<number> {
      return owner.runLifecycle(
        "verify",
        admittedWorkerOperation(context, (scope, identity) =>
          scope.execute({ type: "stateLease.verify", input: { identity } }, { signal }),
        ),
      );
    },
    renew(
      owner: LeaseWorkerOwner,
      leaseMs: number,
      operationLabel: string,
      signal?: AbortSignal,
    ): Promise<number> {
      return owner.runLifecycle(
        "renew",
        admittedWorkerOperation(context, (scope, identity) =>
          scope.execute(
            {
              type: "stateLease.renew",
              input: { identity, leaseMs, operationLabel },
            },
            { signal },
          ),
        ),
      );
    },
    startTimer(
      owner: LeaseWorkerOwner,
      params: {
        observation: BigInt64Array<SharedArrayBuffer>;
        leaseMs: number;
        heartbeatMs: number;
        operationLabel: string;
        signal: AbortSignal;
        onLost(error: unknown): void;
      },
    ): ReturnType<typeof startOpenClawStateLeaseTimer> & {
      verify(): Promise<number>;
      renew(): Promise<number>;
    } {
      const renew = () =>
        storage.renew(owner, params.leaseMs, params.operationLabel, params.signal);
      const timer = startOpenClawStateLeaseTimer({
        observation: params.observation,
        heartbeatMs: params.heartbeatMs,
        async renew() {
          await renew();
        },
        onRenewError(error) {
          try {
            owner.rethrowIfUncertain(error, undefined);
          } catch (uncertainty) {
            params.onLost(uncertainty);
            return;
          }
          if (
            (error instanceof OpenClawStateLeaseError &&
              error.code === "OPENCLAW_STATE_LEASE_LOST") ||
            Number(Atomics.load(params.observation, leaseHeartbeatState.expiresAt)) <= Date.now()
          ) {
            params.onLost(error);
          }
        },
        onLost: (error) => params.onLost(error),
      });
      return {
        ...timer,
        verify: () => storage.verify(owner, params.signal),
        renew,
      };
    },
    release(owner: LeaseWorkerOwner, operationLabel: string): Promise<void> {
      return owner.runLifecycle("release", async (admission) => {
        const { readDatabasePathIdentity } = await import("../infra/sqlite-worker-identity.js");
        const { runSqliteWorkerStoreOperation } = await import("../infra/sqlite-worker-store.js");
        const { openOpenClawStateWorkerCleanupStore } =
          await import("./openclaw-state-worker-store.js");
        admission.assertCurrent();
        const expectedIdentity = context.admission.identity.key;
        const observed = await readDatabasePathIdentity(storage.path);
        if (observed.key !== expectedIdentity) {
          throw new Error("State lease cleanup cannot adopt a replacement shared database");
        }
        admission.assertCurrent();
        const cleanupContext = {
          environment: context.environment,
          existingSchemaPath: context.existingSchemaPath,
          stateIntegrity: context.stateIntegrity,
        };
        // Canonical close seals reads first; this owner retains only release authority.
        const store = await openOpenClawStateWorkerCleanupStore(
          storage.path,
          cleanupContext,
          admission.assertCurrent,
          observed,
        );
        if (!store) {
          throw new Error("State lease cleanup lost its original database");
        }
        const errors: unknown[] = [];
        try {
          await runSqliteWorkerStoreOperation(
            store,
            (scope) =>
              scope.execute({
                type: "stateLease.release",
                input: {
                  identity: admission.identity,
                  operationLabel,
                  databaseIdentity: expectedIdentity,
                },
              }),
            cleanupContext,
            admission.assertCurrent,
            admission.createAdmission,
          );
        } catch (error) {
          errors.push(error);
        }
        try {
          await store.close();
        } catch (error) {
          errors.push(error);
        }
        throwSqliteLifecycleErrors(errors, "State lease release and worker close failed");
      });
    },
  };
  return storage;
}
