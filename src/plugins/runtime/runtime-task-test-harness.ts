// Runtime task test harness helpers build mocked plugin runtimes for task-flow tests.
import { threadId } from "node:worker_threads";
import { expect, vi } from "vitest";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import {
  type HeartbeatWakeRequest,
  requestHeartbeat,
  setHeartbeatWakeHandler,
} from "../../infra/heartbeat-wake.js";
import * as stateCoordinator from "../../infra/state-database-coordinator.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../../tasks/task-runtime.test-helpers.js";

const runtimeTaskMocks = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  cancelSessionMock: vi.fn(),
  killSubagentRunAdminMock: vi.fn(),
  heartbeatWakeMock: vi.fn(async (_request: HeartbeatWakeRequest) => ({
    status: "skipped" as const,
    reason: "disabled",
  })),
}));

const HEARTBEAT_FLUSH_REASON = "runtime-task-test-flush";
let disposeHeartbeatWakeHandler: (() => void) | undefined;

export function getRuntimeTaskMocks() {
  return runtimeTaskMocks;
}

export function installRuntimeTaskDeliveryMock(): void {
  // Terminal task delivery requests heartbeat wakes. Consume them here: a wake left
  // pending with no handler is delivered to the next handler any later test file in
  // the shared worker installs, and that file then observes a foreign wake.
  disposeHeartbeatWakeHandler?.();
  disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(runtimeTaskMocks.heartbeatWakeMock);
  setTaskRegistryDeliveryRuntimeForTests({
    sendMessage: runtimeTaskMocks.sendMessageMock,
  });
  setTaskRegistryControlRuntimeForTests({
    cancelActiveCronTaskRun: () => false,
    getAcpSessionManager: () => ({
      cancelSession: runtimeTaskMocks.cancelSessionMock,
    }),
    killSubagentRunAdmin: (params: unknown) => runtimeTaskMocks.killSubagentRunAdminMock(params),
  });
}

// Runtime task tests write durable rows into the worker's shared state store.
// Skipping the reset write leaves those rows behind, and the next
// ensureTaskRegistryReady() restores them into the process registry as active
// restart blockers for every later test file in the same worker.
export async function resetRuntimeTaskTestState(): Promise<void> {
  let selectedStatePath: string | undefined;
  try {
    selectedStatePath = resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath());
  } catch {
    // Diagnostic path resolution must not replace a cleanup failure.
  }
  await flushHeartbeatWakeRequests();
  disposeHeartbeatWakeHandler?.();
  disposeHeartbeatWakeHandler = undefined;
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryWithCleanupDiagnostic(selectedStatePath);
  resetTaskFlowRegistryForTests();
  vi.clearAllMocks();
}

function resetTaskRegistryWithCleanupDiagnostic(selectedStatePath: string | undefined): void {
  type AcquireOptions = Parameters<typeof stateCoordinator.acquireStateDatabaseCoordinator>[0];
  const observed: {
    failure?: { error: unknown; options: AcquireOptions };
    count: number;
  } = { count: 0 };
  let unavailable: string | undefined;
  let restore: (() => void) | undefined;
  let failure: { error: unknown } | undefined;
  try {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(
        stateCoordinator,
        "acquireStateDatabaseCoordinator",
      );
      if (descriptor && !descriptor.configurable && ("get" in descriptor || "set" in descriptor)) {
        unavailable = "non-configurable-accessor";
      } else {
        const acquire = stateCoordinator.acquireStateDatabaseCoordinator;
        if (vi.isMockFunction(acquire)) {
          unavailable = "already-mocked";
        } else {
          const observer = vi.spyOn(stateCoordinator, "acquireStateDatabaseCoordinator");
          restore = () => observer.mockRestore();
          observer.mockImplementation((options) => {
            try {
              return acquire(options);
            } catch (error) {
              observed.count += 1;
              observed.failure ??= { error, options };
              throw error;
            }
          });
        }
      }
    } catch {
      unavailable = "observer-install-failed";
    }
    try {
      resetTaskRegistryForTests();
    } catch (error) {
      failure = { error };
      throw error;
    }
  } finally {
    try {
      restore?.();
    } catch {
      unavailable = "observer-restore-failed";
    }
    if (failure) {
      let detail: Record<string, string | boolean> = {
        attribution: "unavailable",
        reason: unavailable ?? "unmatched-acquisition",
      };
      try {
        const acquisition = observed.failure;
        // A swallowed failure or aggregate cannot identify the escaping retirement.
        if (
          !unavailable &&
          selectedStatePath !== undefined &&
          observed.count === 1 &&
          acquisition !== undefined &&
          acquisition.error === failure.error &&
          failure.error instanceof stateCoordinator.StateDatabaseCoordinatorContentionError &&
          failure.error.family === "state-lifecycle"
        ) {
          const options = acquisition.options;
          const databasePath = resolvePathViaExistingAncestorSync(options.databasePath);
          const coordinatorPath =
            options.coordinatorPath ??
            stateCoordinator.resolveStateDatabaseCoordinatorPath({
              databasePath: options.databasePath,
              runtimeDirectory:
                options.runtimeDirectory ??
                stateCoordinator.resolveStateLifecycleRuntimeDirectory(),
              uid:
                options.uid ??
                (typeof process.getuid === "function" ? process.getuid() : undefined),
            });
          detail = {
            attribution: "target",
            family: "state-lifecycle",
            databasePathHash: sha256Hex(databasePath),
            coordinatorPathHash: sha256Hex(resolvePathViaExistingAncestorSync(coordinatorPath)),
            targetMatchesSelected: databasePath === selectedStatePath,
          };
        }
      } catch {
        detail = { attribution: "unavailable", reason: "identity-resolution-failed" };
      }
      try {
        process.stderr.write(
          `[runtime-task-cleanup] ${JSON.stringify({
            ...detail,
            requesterPid: process.pid,
            requesterThreadId: threadId,
          })}\n`,
        );
      } catch {
        // Observing or reporting cleanup must preserve the original thrown value.
      }
    }
  }
}

// A sentinel wake proves every earlier pending wake was delivered to this file's handler.
async function flushHeartbeatWakeRequests(): Promise<void> {
  if (!disposeHeartbeatWakeHandler) {
    return;
  }
  requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: HEARTBEAT_FLUSH_REASON,
    coalesceMs: 0,
  });
  await vi.waitFor(() => {
    expect(
      runtimeTaskMocks.heartbeatWakeMock.mock.calls.some(
        ([request]) => request.reason === HEARTBEAT_FLUSH_REASON,
      ),
    ).toBe(true);
  });
}
