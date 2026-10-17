// Cleanup settlement must preserve scheduler ownership across registry replacement.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withPluginCommandExecution } from "../command-execution-lock.js";
import {
  clearPluginHostRuntimeState,
  clearPluginRunContext,
  getPluginRunContext,
  setPluginRunContext,
} from "../host-hook-runtime.js";
import { listPluginSessionSchedulerJobs } from "../host-hook-runtime.test-fixtures.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import {
  clearActivePluginRegistry,
  setActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";

describe("plugin cleanup scheduler ownership", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });
  it("clears only the selected run-context namespace", () => {
    for (const namespace of ["selected", "retained"]) {
      setPluginRunContext({
        pluginId: "cleanup-contract",
        patch: { runId: "cleanup-run", namespace, value: namespace },
      });
    }
    clearPluginRunContext({
      pluginId: "cleanup-contract",
      runId: "cleanup-run",
      namespace: "selected",
    });
    const read = (namespace: string) =>
      getPluginRunContext({
        pluginId: "cleanup-contract",
        get: { runId: "cleanup-run", namespace },
      });
    expect(read("selected")).toBeUndefined();
    expect(read("retained")).toBe("retained");
  });
  it.each([
    { withSuccessor: false, heldWork: false, clear: false },
    { withSuccessor: true, heldWork: false, clear: false },
    { withSuccessor: true, heldWork: true, clear: false },
    { withSuccessor: true, heldWork: true, clear: true },
  ])(
    "preserves scheduler jobs across delayed cleanup (successor=$withSuccessor, heldWork=$heldWork, clear=$clear)",
    async ({ withSuccessor, heldWork, clear }) => {
      const commandRelease = createDeferredCore();
      const cleanupStarted = createDeferredCore();
      const cleanupRelease = createDeferredCore();
      const schedulerCleanup = vi.fn();
      const retiredSchedulerCleanup = vi.fn();
      const pluginId = "delayed-restored-registry-plugin";
      const createFixture = (retiring: boolean) => {
        const fixture = createPluginRegistryFixture();
        registerTestPlugin({
          ...fixture,
          record: createPluginRecord({ id: pluginId, name: "Delayed Restored Registry Plugin" }),
          register(api) {
            if (retiring) {
              api.registerRuntimeLifecycle({
                id: "delayed-cleanup",
                async cleanup() {
                  cleanupStarted.resolve();
                  await cleanupRelease.promise;
                },
              });
            }
            api.registerSessionSchedulerJob({
              id: "live-job",
              sessionKey: "agent:main:main",
              kind: "session-turn",
              cleanup: retiring ? retiredSchedulerCleanup : schedulerCleanup,
            });
          },
        });
        return fixture;
      };
      const previous = createFixture(true);
      setActivePluginRegistry(previous.registry.registry);
      const commandWork = heldWork
        ? withPluginCommandExecution(previous.registry.registry, () => commandRelease.promise)
        : undefined;
      const clearing = clear ? clearActivePluginRegistry(previous.registry.registry) : undefined;
      if (!clear) {
        setActivePluginRegistry(createEmptyPluginRegistry());
      }
      try {
        if (!heldWork) {
          await cleanupStarted.promise;
        }
        if (withSuccessor) {
          const successor = createFixture(false);
          setActivePluginRegistry(successor.registry.registry);
        }

        commandRelease.resolve();
        await commandWork;
        await cleanupStarted.promise;
        cleanupRelease.resolve();
        await waitForPluginRegistryRetirement(previous.registry.registry);
        await clearing;

        expect(retiredSchedulerCleanup).toHaveBeenCalledTimes(heldWork ? 0 : 1);
        expect(schedulerCleanup).not.toHaveBeenCalled();
        expect(listPluginSessionSchedulerJobs(pluginId)).toEqual(
          withSuccessor
            ? [{ id: "live-job", pluginId, sessionKey: "agent:main:main", kind: "session-turn" }]
            : [],
        );
      } finally {
        commandRelease.resolve();
        cleanupRelease.resolve();
        await commandWork;
        await waitForPluginRegistryRetirement(previous.registry.registry);
        await clearing;
      }
    },
  );
});
