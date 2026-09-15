import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import { startOpenClawStateLeaseTimer } from "./openclaw-state-lease-heartbeat.js";
import type { createOpenClawStateLeaseWorkerOwner } from "./openclaw-state-lease-worker-owner.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type LeaseWorkerOwner = ReturnType<typeof createOpenClawStateLeaseWorkerOwner>;

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
    ): Promise<number | undefined> {
      return owner.runLifecycle("acquire", async (admission) => {
        const { runOpenClawStateWorkerOperation } =
          await import("./openclaw-state-worker-store.js");
        return runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute(
              {
                type: "stateLease.acquire",
                input: {
                  identity: admission.identity,
                  leaseMs,
                  operationLabel,
                  ...(observeExpiry ? { observeExpiry: true as const } : {}),
                },
              },
              { signal },
            ),
          { assertCurrent: admission.assertCurrent, createAdmission: admission.createAdmission },
        );
      });
    },
    verify(owner: LeaseWorkerOwner, signal?: AbortSignal): Promise<number> {
      return owner.runLifecycle("verify", async (admission) => {
        const { runOpenClawStateWorkerOperation } =
          await import("./openclaw-state-worker-store.js");
        return runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute(
              { type: "stateLease.verify", input: { identity: admission.identity } },
              { signal },
            ),
          { assertCurrent: admission.assertCurrent, createAdmission: admission.createAdmission },
        );
      });
    },
    renew(
      owner: LeaseWorkerOwner,
      leaseMs: number,
      operationLabel: string,
      signal?: AbortSignal,
    ): Promise<number> {
      return owner.runLifecycle("renew", async (admission) => {
        const { runOpenClawStateWorkerOperation } =
          await import("./openclaw-state-worker-store.js");
        return runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute(
              {
                type: "stateLease.renew",
                input: { identity: admission.identity, leaseMs, operationLabel },
              },
              { signal },
            ),
          { assertCurrent: admission.assertCurrent, createAdmission: admission.createAdmission },
        );
      });
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
    release(owner: LeaseWorkerOwner, operationLabel: string, signal?: AbortSignal): Promise<void> {
      return owner.runLifecycle("release", async (admission) => {
        const { runOpenClawStateWorkerOperation } =
          await import("./openclaw-state-worker-store.js");
        return runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute(
              {
                type: "stateLease.release",
                input: { identity: admission.identity, operationLabel },
              },
              { signal },
            ),
          { assertCurrent: admission.assertCurrent, createAdmission: admission.createAdmission },
        );
      });
    },
  };
  return storage;
}
