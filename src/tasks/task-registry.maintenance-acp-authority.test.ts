import { afterEach, describe, expect, it, vi } from "vitest";
import { listAcpSessionEntries, readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { loadTaskAcpSessionCloser, type CloseAcpSession } from "./task-registry-acp-cleanup.js";
import { captureTaskDeliveryWork } from "./task-registry-delivery.test-support.js";
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
  vi.mocked(readAcpSessionEntry).mockReset().mockReturnValue(null);
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
  vi.mocked(readAcpSessionEntry).mockReset();
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
      vi.mocked(readAcpSessionEntry).mockReturnValue(entry);
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
      });
      expect(unbind).not.toHaveBeenCalled();
    });
  });
});
