import type { SqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import type { OpenClawStateWorkerLeaseContext } from "./openclaw-state-lease-context.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import { startOpenClawStateLeaseTimer } from "./openclaw-state-lease-heartbeat.js";
import type {
  OpenClawStateLeaseAcquisition,
  OpenClawStateLeaseIdentity,
} from "./openclaw-state-lease-store.js";
import {
  withOpenClawStateLeaseWorkerAdmission,
  withOpenClawStateLeasesWorkerAdmission,
  type createOpenClawStateLeaseWorkerOwner,
  type OpenClawStateLeaseWorkerAuthority,
  type WorkerLeaseScope,
} from "./openclaw-state-lease-worker-owner.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";

type LeaseWorkerOwner = ReturnType<typeof createOpenClawStateLeaseWorkerOwner>;
type LeaseWorkerOperation<T> = (
  scope: Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">,
  identity: OpenClawStateLeaseIdentity,
) => Promise<T>;

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
export function createOpenClawStateLeaseWorkerStorage(context: OpenClawStateWorkerContext) {
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
          coordinatorRuntime: { ...context.coordinatorRuntime, keepAlive: false },
          existingSchemaPath: context.existingSchemaPath,
        };
        // Canonical close seals reads first; this owner retains only release authority.
        const store = await openOpenClawStateWorkerCleanupStore(
          storage.path,
          cleanupContext,
          admission.assertCurrent,
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
            true,
          );
        } catch (error) {
          errors.push(error);
        }
        try {
          await store.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "State lease release and worker close failed", {
            cause: errors[0],
          });
        }
      });
    },
  };
  return storage;
}

/** Retain the actual lease until every admitted worker transaction has settled. */
export function runWithOpenClawStateLeaseWorker<T>(
  lease: OpenClawStateWorkerLeaseContext,
  context: OpenClawStateWorkerContext,
  operation: LeaseWorkerOperation<T>,
  authority?: OpenClawStateLeaseWorkerAuthority,
): Promise<T> {
  return withOpenClawStateLeaseWorkerAdmission(
    lease,
    context.admission.databasePath,
    admittedWorkerOperation(context, operation),
    authority,
  );
}

/** Share one actor operation while every original lease retains its native settlement. */
export function runWithOpenClawStateLeasesWorker<T>(
  leases: readonly OpenClawStateWorkerLeaseContext[],
  context: OpenClawStateWorkerContext,
  operation: (
    scope: Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">,
    identities: readonly OpenClawStateLeaseIdentity[],
  ) => Promise<T>,
  authority?: OpenClawStateLeaseWorkerAuthority,
): Promise<T> {
  return withOpenClawStateLeasesWorkerAdmission(
    leases,
    context,
    async (admission) => {
      const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
      admission.assertCurrent();
      return runOpenClawStateWorkerOperation(
        context,
        (scope) => operation(scope, admission.identities),
        {
          assertCurrent: admission.assertCurrent,
          createAdmission: admission.createAdmission,
        },
      );
    },
    authority,
  );
}
