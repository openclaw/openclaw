import { afterEach, describe, expect, it, vi } from "vitest";
import { listAcpSessionEntries, readAcpSessionEntryAsync } from "../acp/runtime/session-meta.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { createAcpTaskBackingDetail } from "./task-backing-records.js";
import { loadTaskAcpSessionCloser, type CloseAcpSession } from "./task-registry-acp-cleanup.js";
import { captureTaskDeliveryWork } from "./task-registry-delivery.test-support.js";
import { updateTask } from "./task-registry-mutation.js";
import {
  configureTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { createAcpSessionStoreEntry } from "./task-registry.maintenance.test-support.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

vi.mock("../acp/runtime/session-meta.js", { spy: true });
vi.mock("./task-registry-acp-cleanup.js", { spy: true });

const parentSessionKey = "agent:main:main";

function createCleanupEffects() {
  const close = vi.fn<CloseAcpSession>().mockResolvedValue(undefined);
  const unbind = vi.spyOn(getSessionBindingService(), "unbind").mockResolvedValue([]);
  vi.mocked(loadTaskAcpSessionCloser).mockReset().mockResolvedValue(close);
  vi.mocked(listAcpSessionEntries).mockReset().mockResolvedValue([]);
  vi.mocked(readAcpSessionEntryAsync).mockReset().mockResolvedValue(null);
  return { close, unbind };
}

async function withAcpCleanupState(
  run: (effects: ReturnType<typeof createCleanupEffects>) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-maintenance-acp-authority-" },
    async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
      try {
        await run(createCleanupEffects());
      } finally {
        await closeOpenClawStateDatabaseAsync();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      }
    },
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(loadTaskAcpSessionCloser).mockReset();
  vi.mocked(listAcpSessionEntries).mockReset();
  vi.mocked(readAcpSessionEntryAsync).mockReset();
  configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await drainGlobalSingletonLifecycleState("close");
});

describe("task maintenance ACP cleanup authority", () => {
  it.each([
    { boundary: "list", permittedCloses: 0, permittedUnbinds: 0 },
    { boundary: "close", permittedCloses: 1, permittedUnbinds: 0 },
    { boundary: "unbind", permittedCloses: 1, permittedUnbinds: 1 },
  ] as const)(
    "stops orphan cleanup when the task store retires during $boundary",
    async ({ boundary, permittedCloses, permittedUnbinds }) => {
      await withAcpCleanupState(async ({ close, unbind }) => {
        const entries = ["first", "second"].map((suffix) =>
          createAcpSessionStoreEntry({
            sessionKey: `agent:main:acp:orphan-${suffix}`,
            parentSessionKey,
            mode: "oneshot",
          }),
        );
        vi.mocked(listAcpSessionEntries).mockResolvedValue(entries);
        vi.mocked(readAcpSessionEntryAsync).mockImplementation(
          async ({ sessionKey }) =>
            entries.find((entry) => entry.sessionKey === sessionKey) ?? null,
        );
        const retireStore = async () => {
          await Promise.resolve();
          configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
        };
        if (boundary === "list") {
          vi.mocked(listAcpSessionEntries).mockImplementationOnce(async () => {
            await retireStore();
            return entries;
          });
        } else if (boundary === "close") {
          close.mockImplementationOnce(retireStore);
        } else {
          unbind.mockImplementationOnce(async () => {
            await retireStore();
            return [];
          });
        }

        await expect(runTaskRegistryMaintenance()).rejects.toThrow(
          "Task registry read owner is no longer current.",
        );
        expect(close.mock.calls.map(([input]) => input.sessionKey)).toEqual(
          entries.slice(0, permittedCloses).map((entry) => entry.sessionKey),
        );
        expect(unbind.mock.calls.map(([input]) => input.targetSessionKey)).toEqual(
          entries.slice(0, permittedUnbinds).map((entry) => entry.sessionKey),
        );
      });
    },
  );

  it("does not unbind a terminal ACP session when closing it retires the task store", async () => {
    await withAcpCleanupState(async ({ close, unbind }) => {
      const entry = createAcpSessionStoreEntry({
        sessionKey: "agent:main:acp:terminal",
        parentSessionKey,
        mode: "oneshot",
      });
      vi.mocked(readAcpSessionEntryAsync).mockResolvedValue(entry);
      using deliveries = captureTaskDeliveryWork();
      createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey: entry.sessionKey,
        runId: "terminal-acp-cleanup-authority",
        task: "Completed parent-owned ACP task",
        status: "succeeded",
        cleanupAfter: Date.now() + 86_400_000,
        notifyPolicy: "silent",
      });
      await deliveries.settle();
      close.mockImplementationOnce(async () => {
        await Promise.resolve();
        configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
      });

      await expect(runTaskRegistryMaintenance()).rejects.toThrow(
        "Task registry read owner is no longer current.",
      );
      expect(close).toHaveBeenCalledExactlyOnceWith({
        cfg: entry.cfg,
        agentId: entry.agentId,
        sessionKey: entry.sessionKey,
        reason: "terminal-task-cleanup",
        assertActive: expect.any(Function),
        expectedControlBinding: {
          sessionId: entry.entry!.sessionId,
          lifecycleRevision: entry.entry!.lifecycleRevision,
          sessionStartedAt: entry.entry!.sessionStartedAt,
          ownerKey: parentSessionKey,
        },
      });
      expect(unbind).not.toHaveBeenCalled();
    });
  });

  it.each(["requester", "backing instance", "status"] as const)(
    "preserves the original terminal task when its %s changes during the ACP read",
    async (change) => {
      await withAcpCleanupState(async ({ close, unbind }) => {
        const entry = createAcpSessionStoreEntry({
          sessionKey: "agent:main:acp:reassigned",
          parentSessionKey,
          mode: "oneshot",
        });
        using deliveries = captureTaskDeliveryWork();
        const task = createTaskFixture("acp", {
          ownerKey: parentSessionKey,
          requesterSessionKey: parentSessionKey,
          childSessionKey: entry.sessionKey,
          runId: "same-run",
          task: "Completed task before reassignment",
          status: "succeeded",
          cleanupAfter: Date.now() + 86_400_000,
          notifyPolicy: "silent",
          detail: createAcpTaskBackingDetail("original", 1),
        });
        await deliveries.settle();
        vi.mocked(readAcpSessionEntryAsync).mockImplementationOnce(async () => {
          await Promise.resolve();
          expect(
            updateTask(
              task.taskId,
              change === "requester"
                ? { requesterSessionKey: "agent:main:other" }
                : change === "backing instance"
                  ? { detail: createAcpTaskBackingDetail("replacement", 2) }
                  : { status: "running" },
            ),
          ).not.toBeNull();
          return entry;
        });

        await runTaskRegistryMaintenance();

        expect(close).not.toHaveBeenCalled();
        expect(unbind).not.toHaveBeenCalled();
        await deliveries.settle();
      });
    },
  );

  it("keeps a successor's bindings when new work starts while terminal close settles", async () => {
    await withAcpCleanupState(async ({ close, unbind }) => {
      const entry = createAcpSessionStoreEntry({
        sessionKey: "agent:main:acp:successor",
        parentSessionKey,
        mode: "oneshot",
      });
      vi.mocked(readAcpSessionEntryAsync).mockResolvedValue(entry);
      using deliveries = captureTaskDeliveryWork();
      createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey: entry.sessionKey,
        runId: "original",
        task: "Completed ACP task",
        status: "succeeded",
        cleanupAfter: Date.now() + 86_400_000,
        notifyPolicy: "silent",
      });
      await deliveries.settle();
      close.mockImplementationOnce(async ({ assertActive }) => {
        assertActive();
        await Promise.resolve();
        createTaskFixture("acp", {
          ownerKey: parentSessionKey,
          requesterSessionKey: parentSessionKey,
          childSessionKey: entry.sessionKey,
          runId: "successor",
          task: "New ACP task",
          notifyPolicy: "silent",
        });
      });

      await runTaskRegistryMaintenance();

      expect(close).toHaveBeenCalledTimes(1);
      expect(unbind).not.toHaveBeenCalled();
      expect(() => close.mock.calls[0]![0].assertActive()).toThrow("no longer active");
      await deliveries.settle();
    });
  });

  it.each(["owner", "lifecycle", "navigation parent"] as const)(
    "rechecks the session binding before unbinding after a %s change",
    async (change) => {
      await withAcpCleanupState(async ({ close, unbind }) => {
        const entry = createAcpSessionStoreEntry({
          sessionKey: "agent:main:acp:binding-change",
          parentSessionKey,
          mode: "oneshot",
        });
        vi.mocked(readAcpSessionEntryAsync).mockResolvedValue(entry);
        using deliveries = captureTaskDeliveryWork();
        createTaskFixture("acp", {
          ownerKey: parentSessionKey,
          requesterSessionKey: parentSessionKey,
          childSessionKey: entry.sessionKey,
          runId: "completed-binding",
          task: "Completed ACP task",
          status: "succeeded",
          cleanupAfter: Date.now() + 86_400_000,
          notifyPolicy: "silent",
        });
        await deliveries.settle();
        close.mockImplementationOnce(async () => {
          await Promise.resolve();
          vi.mocked(readAcpSessionEntryAsync).mockResolvedValue({
            ...entry,
            acp: undefined,
            entry: {
              ...entry.entry!,
              acp: undefined,
              ...(change === "owner"
                ? { spawnedBy: "agent:main:other", parentSessionKey }
                : change === "lifecycle"
                  ? { lifecycleRevision: "replacement" }
                  : { parentSessionKey: "agent:main:other" }),
            },
          });
        });

        await runTaskRegistryMaintenance();

        expect(close).toHaveBeenCalledTimes(1);
        expect(unbind).toHaveBeenCalledTimes(change === "navigation parent" ? 1 : 0);
      });
    },
  );
});
