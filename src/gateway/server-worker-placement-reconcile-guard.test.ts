import { describe, expect, it, vi } from "vitest";
import { installWorkerPlacementReconcileGuard } from "./server-worker-placement-reconcile-guard.js";

const localClaim = {
  owner: "local" as const,
  claimId: "claim-cleanup",
  runId: "run-cleanup",
  generation: 1,
  ownerEpoch: null,
};

function createReconcileGuard(params: {
  turnClaim: typeof localClaim | null;
  activeOwnerEpoch: number | null;
  destroyRequestedAtMs: number | null;
  ownerState?: "failed" | "provisioning" | "active";
  operationInFlight?: boolean;
  environmentState?: "requested" | "provisioning" | "bootstrapping" | "ready" | "idle" | "attached";
}) {
  let guard:
    | ((environmentId: string, reconcileCore: () => Promise<void>) => Promise<void>)
    | undefined;
  const recordError = vi.fn();
  installWorkerPlacementReconcileGuard({
    placements: {
      list: () => [
        {
          sessionId: "session-cleanup",
          state: params.ownerState ?? "failed",
          environmentId: "worker-cleanup",
          turnClaim: params.turnClaim,
          activeOwnerEpoch: params.activeOwnerEpoch,
        },
      ],
    } as never,
    environments: {
      get: (environmentId: string) => ({
        environmentId,
        state: params.environmentState ?? "provisioning",
        destroyRequestedAtMs: params.destroyRequestedAtMs,
      }),
      recordError,
      installReconcileEnvironmentGuard: (installed: typeof guard) => {
        guard = installed;
        return async () => {};
      },
    } as never,
    dispatch: {
      isPlacementOperationInFlight: () => params.operationInFlight === true,
    },
    isStopping: () => false,
  });
  if (!guard) {
    throw new Error("worker placement reconciliation guard was not installed");
  }
  return { guard, recordError };
}

describe("worker placement reconciliation teardown authority", () => {
  it("allows destruction only after its exact failed owner has released all authority", async () => {
    const { guard } = createReconcileGuard({
      turnClaim: null,
      activeOwnerEpoch: null,
      destroyRequestedAtMs: 1,
    });
    const reconcileCore = vi.fn(async () => {});

    await guard("worker-cleanup", reconcileCore);

    expect(reconcileCore).toHaveBeenCalledOnce();
  });

  it.each([
    {
      reason: "a retained local turn claim",
      turnClaim: localClaim,
      activeOwnerEpoch: null,
      destroyRequestedAtMs: 1,
    },
    {
      reason: "an active owner epoch",
      turnClaim: null,
      activeOwnerEpoch: 2,
      destroyRequestedAtMs: 1,
    },
    {
      reason: "no durable destruction request",
      turnClaim: null,
      activeOwnerEpoch: null,
      destroyRequestedAtMs: null,
    },
  ])(
    "keeps failed-placement cleanup fenced with $reason",
    async ({ reason: _reason, ...params }) => {
      const { guard } = createReconcileGuard(params);
      const reconcileCore = vi.fn(async () => {});

      await expect(guard("worker-cleanup", reconcileCore)).rejects.toThrow(
        "provisioning owner is failed",
      );

      expect(reconcileCore).not.toHaveBeenCalled();
    },
  );

  it.each(["requested", "provisioning", "bootstrapping", "ready", "idle"] as const)(
    "does not turn a retained provisioning placement into new authority (%s)",
    async (environmentState) => {
      const { guard } = createReconcileGuard({
        ownerState: "provisioning",
        environmentState,
        turnClaim: null,
        activeOwnerEpoch: null,
        destroyRequestedAtMs: null,
      });
      const reconcileCore = vi.fn(async () => {});
      await expect(guard("worker-cleanup", reconcileCore)).resolves.toBeUndefined();
      expect(reconcileCore).not.toHaveBeenCalled();
    },
  );

  it("continues an existing destroy obligation instead of resuming provisioning", async () => {
    const { guard } = createReconcileGuard({
      ownerState: "provisioning",
      turnClaim: null,
      activeOwnerEpoch: null,
      destroyRequestedAtMs: 1,
    });
    const reconcileCore = vi.fn(async () => {});
    await guard("worker-cleanup", reconcileCore);
    expect(reconcileCore).toHaveBeenCalledOnce();
  });

  it("preserves maintenance for an independently active child", async () => {
    const { guard } = createReconcileGuard({
      ownerState: "active",
      environmentState: "attached",
      turnClaim: null,
      activeOwnerEpoch: 7,
      destroyRequestedAtMs: null,
    });
    const reconcileCore = vi.fn(async () => {});
    await guard("worker-cleanup", reconcileCore);
    expect(reconcileCore).toHaveBeenCalledOnce();
  });

  it("does not label a still-owned foreground dispatch as interrupted", async () => {
    const { guard, recordError } = createReconcileGuard({
      ownerState: "provisioning",
      operationInFlight: true,
      turnClaim: null,
      activeOwnerEpoch: null,
      destroyRequestedAtMs: null,
    });
    const reconcileCore = vi.fn(async () => {});
    await guard("worker-cleanup", reconcileCore);
    expect(reconcileCore).not.toHaveBeenCalled();
    expect(recordError).not.toHaveBeenCalled();
  });
});
