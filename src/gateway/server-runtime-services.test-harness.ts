import { vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { scheduleGatewayPostReadyMaintenance } from "./server-runtime-services.js";

type StartSessionDeliveryRuntime =
  typeof import("../infra/session-delivery-queue-runtime.js").startSessionDeliveryRuntime;
type DrainPendingDeliveries =
  typeof import("../infra/outbound/delivery-queue-recovery.js").drainPendingDeliveriesCore;
type RecoverPendingDeliveries =
  typeof import("../infra/outbound/delivery-queue-recovery.js").recoverPendingDeliveries;

const runtimeServiceMocks = vi.hoisted(() => {
  const stopSessionUpstreamMonitor = vi.fn();
  const stopSessionDeliveryRuntime = vi.fn(async () => {});
  return {
    warmGatewayDatabasePageCache: vi.fn(async () => {}),
    startChannelHealthMonitor: vi.fn(() => ({
      stop: vi.fn(),
      shutdown: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
    })),
    stopSessionUpstreamMonitor,
    stopSessionDeliveryRuntime,
    startSessionDeliveryRuntime: vi.fn<StartSessionDeliveryRuntime>(
      () => stopSessionDeliveryRuntime,
    ),
    schedulePendingSessionDeliveries: vi.fn(async () => undefined),
    startSessionUpstreamMonitor: vi.fn(() => ({ stop: stopSessionUpstreamMonitor })),
    recoverPendingDeliveries: vi.fn<RecoverPendingDeliveries>(async () => ({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    })),
    countPendingDeliveryQueueEntries: vi.fn(async () => 0),
    drainPendingDeliveries: vi.fn<DrainPendingDeliveries>(async () => undefined),
    recoverPendingProducedSessionDeliveries: vi.fn(async () => undefined),
    recoverPendingContinuationDelegates: vi.fn(async () => ({
      sessions: 0,
      dispatched: 0,
      rejected: 0,
    })),
    requeueAwaitingNextCompactionDelegates: vi.fn(async () => ({ requeued: 0 })),
    recoverAndReleaseStagedPostCompactionDelegates: vi.fn(async () => ({
      sessions: 0,
      dispatched: 0,
      failed: 0,
    })),
    recoverPendingContinuationWork: vi.fn(async () => ({
      sessions: 0,
      dispatched: 0,
      failed: 0,
      reaped: 0,
      terminalNotices: 0,
    })),
    deliverQueuedSessionDelivery: vi.fn(async () => undefined),
    settleQueuedSessionDelivery: vi.fn(async () => undefined),
    deliverOutboundPayloads: vi.fn(),
    withAuthorizedQueuedConversationDelivery: vi.fn(),
  };
});

// mock-isolation: Scheduler tests do not inspect or warm host database files.
vi.mock("./server-database-page-cache.js", () => ({
  warmGatewayDatabasePageCache: runtimeServiceMocks.warmGatewayDatabasePageCache,
}));

vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: runtimeServiceMocks.startSessionUpstreamMonitor,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: runtimeServiceMocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: runtimeServiceMocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  recoverPendingDeliveries: runtimeServiceMocks.recoverPendingDeliveries,
  drainPendingDeliveriesCore: runtimeServiceMocks.drainPendingDeliveries,
}));

vi.mock("../infra/delivery-queue-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/delivery-queue-sqlite.js")>()),
  countPendingDeliveryQueueEntries: runtimeServiceMocks.countPendingDeliveryQueueEntries,
}));

vi.mock("./conversation-route-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conversation-route-ownership.js")>()),
  withAuthorizedQueuedConversationDelivery:
    runtimeServiceMocks.withAuthorizedQueuedConversationDelivery,
}));

vi.mock("../infra/session-delivery-queue-runtime.js", () => ({
  startSessionDeliveryRuntime: runtimeServiceMocks.startSessionDeliveryRuntime,
  schedulePendingSessionDeliveries: runtimeServiceMocks.schedulePendingSessionDeliveries,
}));

vi.mock("./server-restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-restart-sentinel.js")>()),
  deliverQueuedSessionDelivery: runtimeServiceMocks.deliverQueuedSessionDelivery,
  recoverPendingProducedSessionDeliveries:
    runtimeServiceMocks.recoverPendingProducedSessionDeliveries,
  settleQueuedSessionDelivery: runtimeServiceMocks.settleQueuedSessionDelivery,
}));

// mock-isolation: Startup delegate recovery is recorded without reading continuation custody.
vi.mock("../auto-reply/continuation/delegate-dispatch-recovery.js", () => ({
  recoverPendingContinuationDelegates: runtimeServiceMocks.recoverPendingContinuationDelegates,
  requeueAwaitingNextCompactionDelegates:
    runtimeServiceMocks.requeueAwaitingNextCompactionDelegates,
  recoverAndReleaseStagedPostCompactionDelegates:
    runtimeServiceMocks.recoverAndReleaseStagedPostCompactionDelegates,
}));

// mock-isolation: Startup work recovery is recorded without reading continuation custody.
vi.mock("../auto-reply/continuation/work-dispatch.js", () => ({
  recoverPendingContinuationWork: runtimeServiceMocks.recoverPendingContinuationWork,
}));

// Custody boot's own worker reads (phase A and the retention
// prune) answer at once here, like the recovery owners above. A real worker
// reply arrives over a MessagePort that fake-timer advances do not wait for,
// which would leave recovery's root-work admission open across these tests.
vi.mock("../auto-reply/continuation/custody/custody-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation/custody/custody-store.js")>()),
  whenContinuationCustodyReady: async () => undefined,
  pruneContinuationRecords: async () => ({ deletedRecordIds: [] }),
}));

vi.mock("./channel-health-monitor.js", () => ({
  startChannelHealthMonitor: runtimeServiceMocks.startChannelHealthMonitor,
}));

// Vitest moves the declaration before imports; it rejects an exported hoisted declaration.
export { runtimeServiceMocks };

export { waitForFast } from "../../test/helpers/vitest-wait.js";

export function createLog() {
  return {
    child: vi.fn(() => createInfoWarnErrorLogger()),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function createTestCronState(
  cron: { start: () => Promise<void> } = { start: vi.fn(async () => {}) },
  cronEnabled = true,
) {
  return {
    cron,
    storePath: "/tmp/cron.json",
    cronEnabled,
  } as never;
}

export function createTestCronReconciliation(complete: () => Promise<void> = async () => {}) {
  const completeMock = vi.fn<() => Promise<void>>(complete);
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete: completeMock })),
    complete: completeMock,
    invalidate: vi.fn(),
  };
}

export function createPostReadyMaintenanceScheduleParams(
  overrides: Partial<Parameters<typeof scheduleGatewayPostReadyMaintenance>[0]> &
    Pick<Parameters<typeof scheduleGatewayPostReadyMaintenance>[0], "scheduler">,
): Parameters<typeof scheduleGatewayPostReadyMaintenance>[0] {
  return {
    signal: new AbortController().signal,
    delayMs: 1,
    isClosing: () => false,
    waitForPostReadyWork: async () => {},
    scheduleSessionFactsBackfill: vi.fn(),
    startupMaintenance: {
      startupSessionDatabases: [],
      pluginRuntime: { registry: createEmptyPluginRegistry() },
    },
    startMaintenance: vi.fn(async () => null),
    applyMaintenance: vi.fn(),
    shouldStartCron: () => true,
    markCronStartHandled: vi.fn(),
    cronState: createTestCronState(),
    cronReconciliation: createTestCronReconciliation(),
    cronConfig: {} as never,
    logCron: { error: vi.fn() },
    log: createLog(),
    recordPostReadyMemory: vi.fn(),
    ...overrides,
  };
}

export function createMaintenanceHandles() {
  return {
    stopPeriodicTasks: vi.fn(async () => {}),
    startMediaCleanup: vi.fn(async () => undefined),

    stopMediaCleanup: vi.fn(async () => "drained" as const),

    skillUsageCleanup: vi.fn(async () => {}),
  };
}

export function resetRuntimeServiceMocks() {
  runtimeServiceMocks.warmGatewayDatabasePageCache.mockReset().mockResolvedValue(undefined);
  runtimeServiceMocks.startChannelHealthMonitor.mockClear();
  runtimeServiceMocks.startSessionUpstreamMonitor.mockClear();
  runtimeServiceMocks.stopSessionUpstreamMonitor.mockClear();
  runtimeServiceMocks.stopSessionDeliveryRuntime.mockClear();
  runtimeServiceMocks.startSessionDeliveryRuntime.mockClear();
  runtimeServiceMocks.schedulePendingSessionDeliveries.mockClear();
  runtimeServiceMocks.recoverPendingDeliveries.mockReset();
  runtimeServiceMocks.recoverPendingDeliveries.mockResolvedValue({
    recovered: 0,
    failed: 0,
    skippedMaxRetries: 0,
    deferredBackoff: 0,
  });
  runtimeServiceMocks.countPendingDeliveryQueueEntries.mockReset().mockResolvedValue(0);
  runtimeServiceMocks.drainPendingDeliveries.mockReset();
  runtimeServiceMocks.drainPendingDeliveries.mockResolvedValue(undefined);
  runtimeServiceMocks.recoverPendingProducedSessionDeliveries.mockClear();
  runtimeServiceMocks.deliverQueuedSessionDelivery.mockClear();
  runtimeServiceMocks.settleQueuedSessionDelivery.mockClear();
  runtimeServiceMocks.deliverOutboundPayloads.mockClear();
  runtimeServiceMocks.withAuthorizedQueuedConversationDelivery.mockReset();
}
