import { vi } from "vitest";
import type {
  WorkerEnvironmentServiceContract,
  WorkerEnvironmentServiceRecord,
} from "../worker-environments/service-contract.js";
import type { WorkerEnvironmentRecord } from "../worker-environments/store.js";
import { environmentsHandlers } from "./environments.js";

export type TestWorkerRecord = WorkerEnvironmentRecord & WorkerEnvironmentServiceRecord;

export type TestWorkerService = Omit<
  WorkerEnvironmentServiceContract,
  "startTunnel" | "stopTunnel"
>;

export function mockContext(
  workerEnvironmentService?: TestWorkerService,
  reconcileActive: (environmentId?: string) => Promise<void> = vi.fn(async () => {}),
  forceDestroyEnvironment: (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) => Promise<TestWorkerRecord> = vi.fn(async () => workerRecord({ state: "destroyed" })),
  connectedNodes: unknown[] = [
    {
      nodeId: "node-live",
      connId: "conn-live",
      displayName: "Live Node",
      platform: "ios",
      caps: ["camera"],
      commands: ["system.run"],
      connectedAtMs: 123,
    },
  ],
) {
  return {
    logGateway: {
      warn: vi.fn(),
    },
    nodeRegistry: {
      listConnectedForPairingStates: () => connectedNodes,
    },
    workerEnvironmentService,
    getRuntimeConfig: () => ({
      cloudWorkers: {
        profiles: {
          zeta: { provider: "static-ssh", settings: {} },
          aws: { provider: "crabbox", settings: {} },
        },
      },
    }),
    ...(workerEnvironmentService
      ? {
          workerPlacementDispatchService: {
            dispatch: vi.fn(),
            forceDestroyEnvironment,
            reconcileActive,
          },
        }
      : {}),
  };
}

export function workerRecord(overrides: Partial<TestWorkerRecord> = {}): TestWorkerRecord {
  return {
    environmentId: "worker-1",
    providerId: "static-ssh",
    profileId: "development",
    profileSnapshot: { settings: {} },
    provisionOperationId: "provision:worker-1",
    leaseId: "lease-1",
    sharedHost: false,
    desktop: null,
    sshEndpoint: {
      host: "worker.example.test",
      port: 22,
      user: "openclaw",
      hostKey: ["ssh-ed25519", "AAAA"].join(" "),
      keyRef: { source: "file", provider: "default", id: "/worker/private-key" },
    },
    state: "ready",
    attachedSessionIds: [],
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    stateChangedAtMs: 1_000,
    idleSinceAtMs: null,
    lastError: null,
    tunnelStatus: "stopped",
    desktopAvailable: false,
    desktopApps: [],
    ...overrides,
  } as TestWorkerRecord;
}

export const workerService = (overrides: Partial<TestWorkerService> = {}) => ({
  list: vi.fn(() => []),
  get: vi.fn(() => undefined),
  inventoryVersion: vi.fn(() => 0),
  supportsExecutionMode: vi.fn(() => false),
  listMachineOptions: vi.fn(async () => undefined),
  listOperatingSystems: vi.fn(async () => undefined),
  create: vi.fn(async () => workerRecord()),
  prepare: vi.fn(async () => ({
    environmentId: "worker-1",
    preparationKey: "project-key",
    reused: false,
  })),
  destroy: vi.fn(async () => workerRecord({ state: "destroyed" })),
  destroyUnattached: vi.fn(async () => workerRecord({ state: "destroyed" })),
  observeDesktop: vi.fn(async ({ control }) => ({
    transport: "rfb" as const,
    wsPath: "/desktop/observe?token=abc",
    expiresAtMs: 70_000,
    control,
  })),
  launchDesktopApp: vi.fn(async ({ app }) => ({ app, status: "ready" as const })),
  ...overrides,
});

export async function callEnvironmentMethod(
  method:
    | "environments.list"
    | "environments.status"
    | "environments.create"
    | "environments.prepare"
    | "environments.destroy"
    | "worker.desktop.observe"
    | "worker.desktop.launch",
  params: unknown,
  options: {
    service?: TestWorkerService;
    reconcileActive?: (environmentId?: string) => Promise<void>;
    forceDestroyEnvironment?: (
      environmentId: string,
      onCleanupError?: (error: unknown) => void,
    ) => Promise<TestWorkerRecord>;
    connectedNodes?: unknown[];
  } = {},
) {
  const respond = vi.fn();
  await environmentsHandlers[method]?.({
    params: params as Record<string, unknown>,
    respond,
    context: mockContext(
      options.service,
      options.reconcileActive,
      options.forceDestroyEnvironment,
      options.connectedNodes,
    ),
  } as never);
  const call = respond.mock.calls.at(0);
  if (call === undefined) {
    throw new Error("expected environments handler to respond");
  }
  return call;
}

export class FakeWorkerServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
