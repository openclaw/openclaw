// Cleanup callbacks retain their retiring run-context view across asynchronous work.
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
import type { OpenClawPluginApi } from "../types.js";

describe("plugin cleanup run context", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });
  it.each([
    { withSuccessor: false, heldWork: false, clear: false },
    { withSuccessor: true, heldWork: false, clear: false },
    { withSuccessor: true, heldWork: true, clear: false },
    { withSuccessor: true, heldWork: true, clear: true },
  ])(
    "isolates async cleanup run-context writes (successor=$withSuccessor, heldWork=$heldWork, clear=$clear)",
    async ({ withSuccessor, heldWork, clear }) => {
      const commandRelease = createDeferredCore();
      const cleanupStarted = createDeferredCore();
      const cleanupRelease = createDeferredCore();
      const schedulerCleanup = vi.fn();
      const retiredSchedulerCleanup = vi.fn();
      const pluginId = "delayed-restored-registry-plugin";
      const runId = "restored-after-cleanup-started";
      let cleanupContext: unknown;
      let resumedContext: unknown;
      let originalNamespace: unknown;
      let writtenContext: unknown;
      const cleanupWrites: boolean[] = [];
      const createFixture = (retiring: boolean) => {
        const fixture = createPluginRegistryFixture();
        let capturedApi: OpenClawPluginApi | undefined;
        registerTestPlugin({
          ...fixture,
          record: createPluginRecord({ id: pluginId, name: "Delayed Restored Registry Plugin" }),
          register(api) {
            capturedApi = api;
            if (retiring) {
              api.registerRuntimeLifecycle({
                id: "delayed-cleanup",
                async cleanup() {
                  cleanupContext = getPluginRunContext({
                    pluginId,
                    get: { runId, namespace: "state" },
                  });
                  originalNamespace = getPluginRunContext({
                    pluginId,
                    get: { runId, namespace: "remove" },
                  });
                  cleanupStarted.resolve();
                  await cleanupRelease.promise;
                  resumedContext = getPluginRunContext({
                    pluginId,
                    get: { runId, namespace: "state" },
                  });
                  cleanupWrites.push(
                    setPluginRunContext({
                      pluginId,
                      patch: {
                        runId,
                        namespace: "state",
                        value: { cleanup: true },
                      },
                    }),
                  );
                  writtenContext = getPluginRunContext({
                    pluginId,
                    get: { runId, namespace: "state" },
                  });
                  cleanupWrites.push(
                    setPluginRunContext({
                      pluginId,
                      patch: {
                        runId,
                        namespace: "remove",
                        unset: true,
                      },
                    }),
                  );
                  cleanupWrites.push(
                    setPluginRunContext({
                      pluginId,
                      patch: {
                        runId: `${runId}-created`,
                        namespace: "state",
                        value: { cleanup: true },
                      },
                    }),
                  );
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
        return { ...fixture, api: capturedApi };
      };
      const previous = createFixture(true);
      setActivePluginRegistry(previous.registry.registry);
      expect(
        previous.api?.setRunContext({ runId, namespace: "state", value: { restored: true } }),
      ).toBe(true);
      expect(
        previous.api?.setRunContext({
          runId,
          namespace: "remove",
          value: { original: true },
        }),
      ).toBe(true);
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
          expect(cleanupContext).toEqual({ restored: true });
        }
        if (withSuccessor) {
          const successor = createFixture(false);
          setActivePluginRegistry(successor.registry.registry);
          expect(
            successor.api?.setRunContext({
              runId,
              namespace: "state",
              value: { restored: true },
            }),
          ).toBe(true);
          expect(
            successor.api?.setRunContext({
              runId,
              namespace: "remove",
              value: { successor: true },
            }),
          ).toBe(true);
        }

        commandRelease.resolve();
        await commandWork;
        await cleanupStarted.promise;
        cleanupRelease.resolve();
        await waitForPluginRegistryRetirement(previous.registry.registry);
        await clearing;

        expect(cleanupContext).toEqual({ restored: true });
        expect(resumedContext).toEqual({ restored: true });
        expect(originalNamespace).toEqual({ original: true });
        expect(cleanupWrites).toEqual([true, true, true]);
        expect(writtenContext).toEqual({ cleanup: true });
        expect(getPluginRunContext({ pluginId, get: { runId, namespace: "state" } })).toEqual(
          withSuccessor ? { restored: true } : undefined,
        );
        expect(getPluginRunContext({ pluginId, get: { runId, namespace: "remove" } })).toEqual(
          withSuccessor ? { successor: true } : undefined,
        );
        expect(
          getPluginRunContext({
            pluginId,
            get: { runId: `${runId}-created`, namespace: "state" },
          }),
        ).toBeUndefined();
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
