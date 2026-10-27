import { vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";

type RuntimeFactory = typeof createGatewayWorkerPlacementRuntime;
type RuntimeOptions = Parameters<RuntimeFactory>[0];
type Placement = { sessionId: string; environmentId?: string | null };

export const placementAsyncDefaults = (read: () => readonly Placement[] = () => []) => ({
  subscribeChanges: () => () => {},
  workspaceResultInstanceId: () => "gateway-test",
  getAsync: async (id: string) => read().find((row) => row.sessionId === id),
  getManyAsync: async (ids: readonly string[]) =>
    new Map(
      read()
        .filter((row) => ids.includes(row.sessionId))
        .map((row) => [row.sessionId, row]),
    ),
  listAsync: async () => read(),
  retireSessionPlacementAsync: vi.fn(async () => {}),
  pruneOrphanedWorkspaceReconciliations: async () => [],
  listWorkspaceReconciliationOwners: async () => [],
  listPendingWorkspaceResultsAsync: async () => [],
});

export const placementStoreDefaults = (read: () => readonly Placement[] = () => []) => ({
  ...placementAsyncDefaults(read),
  get: () => undefined,
  list: read,
  readChangeSnapshot: async () => read(),
  readEnvironmentOwner: async (id: string) => read().find((row) => row.environmentId === id),
  readProjection: async () => ({
    placements: new Map(read().map((row) => [row.sessionId, row])),
  }),
  listPendingWorkspaceResultsAsync: () => [],
});

export const createEnvironments = () => ({
  machineShapeNotifications: { onChanged: (_profileId: string) => {} },
  installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
  start: vi.fn(),
  isStopping: () => false,
  beginClose: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
});

export const createIdleDiskSpace = () => ({
  read: vi.fn(),
  version: vi.fn(() => 0),
  invalidate: vi.fn(),
  nextSweepAtMs: () => Infinity,
  sweep: vi.fn().mockResolvedValue(undefined),
});

export function setDispatchMock(
  factory: ReturnType<typeof vi.fn>,
  overrides: Partial<WorkerPlacementDispatchService> = {},
) {
  factory.mockReturnValue({
    dispatch: vi.fn(),
    forceDestroyEnvironment: vi.fn(),
    reclaim: vi.fn(),
    subscribeOrphanWorkspaceChanges: () => () => {},
    reconcile: vi.fn().mockResolvedValue(undefined),
    reconcileActive: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

// The caller supplies the runtime after its module mocks have been installed.
export function createRuntimeFactory(
  factory: RuntimeFactory,
  getCommittedRuntimeConfig: RuntimeOptions["getCommittedRuntimeConfig"],
) {
  return (options: Partial<RuntimeOptions>) =>
    factory({
      initialPlacements: [],
      scheduler: createTestGatewayScheduler(),
      getCommittedRuntimeConfig,
      cancelSessionWork: vi.fn(async () => {}),
      placements: placementStoreDefaults() as never,
      environments: createEnvironments() as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
      ...options,
    });
}

export function startRuntime(
  runtime: ReturnType<RuntimeFactory>,
  hooks: Partial<Parameters<ReturnType<RuntimeFactory>["startRuntime"]>[0]> = {},
) {
  return runtime.startRuntime({
    isClosePreludeStarted: () => false,
    registerSidecar: vi.fn(),
    unregisterSidecar: vi.fn(),
    ...hooks,
  });
}
