import { afterEach, describe, expect, it, vi } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { getDetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime.js";
import { getTaskById } from "../tasks/task-registry.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import { createTaskFixture } from "../tasks/task-registry.test-support.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
} from "../tasks/task-runtime.test-helpers.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { NodeRegistry } from "./node-registry.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { startGatewayEarlyRuntime } from "./server-startup-early.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

vi.mock("../infra/machine-name.js", () => ({ getMachineDisplayName: () => "Canary test" }));
vi.mock("./server-discovery-runtime.js", () => ({ startGatewayDiscovery: async () => null }));
vi.mock("../skills/runtime/remote.js", () => ({
  setSkillsRemoteRegistry: () => {},
  primeRemoteSkillsCache: async () => {},
  refreshRemoteBinsForConnectedNodes: async () => {},
}));
vi.mock("../skills/runtime/refresh.js", () => ({
  registerSkillsChangeListener: () => () => {},
  closeSkillsWatchers: async () => {},
}));

afterEach(async () => {
  stopTaskRegistryMaintenance();
  vi.useRealTimers();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await drainGlobalSingletonLifecycleState("close");
});

describe("early startup task maintenance", () => {
  it.each([false, true])(
    "preserves copied tasks only in an update canary (updateCanary: %s)",
    async (updateCanary) => {
      await withStateDirEnv("openclaw-canary-tasks-", async () => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        vi.useFakeTimers();
        const recoverTask = vi.fn(async () => ({ recovered: false }));
        setDetachedTaskLifecycleRuntime({
          ...getDetachedTaskLifecycleRuntime(),
          tryRecoverTaskBeforeMarkLost: recoverTask,
        });
        const staleAt = Date.now() - 45 * 60_000;
        const copiedTask = createTaskFixture("cli", {
          task: "Synthetic copied task",
          runId: "canary-copied-run",
          lastEventAt: staleAt,
          notifyPolicy: "silent",
        });
        const expiredTask = createTaskFixture("cli", {
          task: "Synthetic expired task",
          status: "succeeded",
          lastEventAt: staleAt,
          cleanupAfter: staleAt,
          notifyPolicy: "silent",
        });
        const recentTask = createTaskFixture("cli", {
          task: "Synthetic task within recovery grace",
          runId: "canary-recent-run",
          lastEventAt: Date.now() - 4 * 60_000,
          notifyPolicy: "silent",
        });
        const log = { info: () => {}, warn: () => {} };
        const earlyRuntime = await startGatewayEarlyRuntime({
          ...createGatewayMaintenanceStateForTest(),
          minimalTestGateway: false,
          updateCanary,
          cfgAtStart: {},
          port: 18_789,
          gatewayTls: { enabled: false },
          gatewayDirectReachable: false,
          tailscaleMode: "off",
          log,
          logDiscovery: log,
          nodeRegistry: new NodeRegistry(),
          swapDiscovery: () => null,
          pluginRuntimeClaim: createGatewayPluginRuntimeGeneration({
            getServices: () => null,
            setServices: () => {},
          }).currentClaim(),
          skillsRefreshDelayMs: 30_000,
          getSkillsRefreshTimer: () => null,
          setSkillsRefreshTimer: () => {},
        });
        try {
          // Exercise both the startup sweep and the recurring maintenance sweep.
          for (const elapsedMs of [5_000, 60_000]) {
            await vi.advanceTimersByTimeAsync(elapsedMs);
            if (updateCanary) {
              expect(getTaskById(copiedTask.taskId)).toEqual(copiedTask);
              expect(getTaskById(expiredTask.taskId)).toEqual(expiredTask);
              expect(getTaskById(recentTask.taskId)).toEqual(recentTask);
              expect(recoverTask).not.toHaveBeenCalled();
            } else {
              expect(getTaskById(copiedTask.taskId)?.status).toBe("lost");
              expect(getTaskById(expiredTask.taskId)).toBeUndefined();
              expect(getTaskById(recentTask.taskId)?.status).toBe(
                elapsedMs === 5_000 ? "running" : "lost",
              );
              expect(recoverTask).toHaveBeenCalledTimes(elapsedMs === 5_000 ? 1 : 2);
            }
          }
        } finally {
          stopTaskRegistryMaintenance();
          await earlyRuntime.skillsChangeUnsub();
          vi.useRealTimers();
        }
      });
    },
  );
});
