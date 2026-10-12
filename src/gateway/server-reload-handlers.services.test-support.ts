import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createServiceRegistration } from "../plugins/services.test-support.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type {
  GatewayReloadHandlerParams,
  ManagedGatewayConfigReloaderHandle,
  ManagedGatewayConfigReloaderParams,
} from "./server-reload-contracts.js";
import { nextGatewayReloadGeneration } from "./server-reload-generation.js";
import {
  captureConfigWriteListener,
  createConfigWriteListenerRef,
  createConfigWriteNotification,
  createHotTailPlan,
  createValidConfigSnapshot,
  makePluginReloadResult,
} from "./server-reload-handlers.config.test-support.js";
import type { createGatewayReloadHandlers as createGatewayReloadHandlersImpl } from "./server-reload-hot.js";
import * as modelRuntime from "./server-reload-model-runtime-scope.js";

export function registerGatewayTargetedServiceReloadTests({
  createGatewayReloadHandlers,
  startManagedGatewayConfigReloader,
}: {
  createGatewayReloadHandlers: (
    params: Partial<GatewayReloadHandlerParams>,
  ) => ReturnType<typeof createGatewayReloadHandlersImpl>;
  startManagedGatewayConfigReloader: (
    params: Pick<
      ManagedGatewayConfigReloaderParams,
      "initialConfig" | "readSnapshot" | "subscribeToWrites"
    > &
      Partial<ManagedGatewayConfigReloaderParams>,
  ) => ManagedGatewayConfigReloaderHandle;
}): void {
  describe("gateway targeted service reload", () => {
    it("forwards the service owner through managed config publication", async () => {
      vi.useFakeTimers();
      const registry = createTestRegistry([]);
      registry.services.push(
        createServiceRegistration(
          { id: "exporter", reload: { configPrefixes: ["diagnostics.otel"] }, start() {} },
          { pluginId: "exporter" },
        ),
      );
      setActivePluginRegistry(registry);
      const initialConfig: OpenClawConfig = { diagnostics: { otel: { enabled: true } } };
      const nextConfig: OpenClawConfig = { diagnostics: { otel: { enabled: false } } };
      const listener = createConfigWriteListenerRef();
      const reloadPluginServices = vi.fn(async () => {});
      const reloader = startManagedGatewayConfigReloader({
        initialConfig,
        readSnapshot: async () => createValidConfigSnapshot(nextConfig, "otel-disabled"),
        subscribeToWrites: captureConfigWriteListener(listener),
        reloadPluginServices,
      });
      await reloader.ready;
      try {
        const application = createRuntimeConfigWriteApplication();
        if (!listener.current) {
          throw new Error("Expected managed config write listener");
        }
        listener.current(
          attachRuntimeConfigWriteApplication(
            createConfigWriteNotification(nextConfig, "otel-disabled", 1, "runtime", "source"),
            application,
          ),
        );
        await vi.advanceTimersByTimeAsync(0);
        await expect(application.result).resolves.toBe("applied");
        expect(reloadPluginServices).toHaveBeenCalledExactlyOnceWith(
          nextConfig,
          new Set(["exporter"]),
        );
      } finally {
        await reloader.stop();
      }
    });

    it.each([
      "success",
      "failure",
      "superseded",
      "plugin failure",
      "model failure",
      "model recovery failure",
      "retired gateway",
    ] as const)(
      "reloads retained services after a different plugin changes in the same config publication (%s)",
      async (outcome) => {
        vi.useFakeTimers();
        const registry = createTestRegistry([]);
        for (const id of ["replaced", "retained"]) {
          registry.services.push(createServiceRegistration({ id, start() {} }, { pluginId: id }));
        }
        const runtime = {
          operationId: "mixed-services",
          generation: 1,
          pluginIds: ["replaced"],
          sourceDigests: {},
        };
        const events: string[] = [];
        let modelsSettled = false;
        const refreshModels = vi
          .spyOn(modelRuntime, "refreshModelRuntimeAfterHotReload")
          .mockImplementation(async () => {
            await Promise.resolve();
            modelsSettled = true;
            events.push("models-settled");
            if (outcome === "retired gateway") {
              nextGatewayReloadGeneration();
            }
            if (outcome === "model failure" || outcome === "model recovery failure") {
              throw new Error("Model preparation failed");
            }
          });
        onTestFinished(() => refreshModels.mockRestore());
        const pluginFailure =
          outcome === "plugin failure" ||
          outcome === "model recovery failure" ||
          outcome === "retired gateway";
        let current = true;
        const logReload = { info: vi.fn(), warn: vi.fn() };
        const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
        const reloadPluginServices = vi.fn(async () => {
          expect(modelsSettled).toBe(true);
          events.push("retained-service");
          if (outcome === "failure" || outcome === "superseded") {
            current = outcome !== "superseded";
            throw new Error("retained service failed");
          }
        });
        const handlers = createGatewayReloadHandlers({
          logReload,
          requestRecoveryRestart,
          getPluginRegistry: () => registry,
          reloadPluginServices,
          reloadPlugins: async ({ commitRuntime, prepareConfigEffects }) => {
            prepareConfigEffects({
              pluginIds: new Set(runtime.pluginIds),
              channels: new Set(),
            }).retire();
            await commitRuntime();
            events.push("replaced-plugin");
            if (pluginFailure) {
              throw new PluginRuntimeApplicationError("Plugin activation failed", {
                ...runtime,
                phase: "activate",
                committed: true,
              });
            }
            return makePluginReloadResult({ runtime });
          },
        });
        const nextConfig: OpenClawConfig = { diagnostics: { otel: { enabled: false } } };
        try {
          const applying = handlers.applyHotReload(
            createHotTailPlan({
              changedPaths: ["plugins.entries.replaced.enabled", "diagnostics.otel.enabled"],
              reloadPlugins: true,
              pluginLifecycle: {
                operationId: runtime.operationId,
                pluginIds: ["replaced"],
                reason: "enable",
              },
              restartServices: new Set(["replaced", "retained"]),
            }),
            nextConfig,
            {
              sourceConfig: nextConfig,
              isCurrent: () => current,
              publish: async (commit) => {
                await commit();
                events.push("published");
              },
            },
          );
          if (pluginFailure) {
            await expect(applying).rejects.toThrow(
              outcome === "model recovery failure"
                ? "Plugin model/reply recovery failed"
                : "Plugin activation failed",
            );
          } else if (outcome === "model failure") {
            await expect(applying).rejects.toThrow(
              "Plugin runtime application failed during prepared model runtime reload",
            );
          } else {
            await expect(applying).resolves.toEqual({ status: "applied", runtime });
          }
          expect(events).toEqual([
            "published",
            "replaced-plugin",
            "models-settled",
            ...(outcome === "retired gateway" ? [] : ["retained-service"]),
          ]);
          if (outcome === "retired gateway") {
            expect(reloadPluginServices).not.toHaveBeenCalled();
          } else {
            expect(reloadPluginServices).toHaveBeenCalledExactlyOnceWith(
              nextConfig,
              new Set(["retained"]),
            );
          }
          await vi.advanceTimersByTimeAsync(500);
          expect(requestRecoveryRestart).not.toHaveBeenCalled();
          if (outcome === "failure" || outcome === "superseded") {
            expect(logReload.warn).toHaveBeenCalledWith(
              "plugin services reload failed: retained service failed",
            );
          }
        } finally {
          handlers.stopRestartRetries();
        }
      },
    );
  });
}
