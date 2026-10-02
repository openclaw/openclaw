import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginReadinessCriterionRegistration } from "../../plugins/registry-types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ManagedGatewayConfigReloaderParams } from "../server-reload-contracts.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  resetTestPluginRegistry,
  setTestPluginRegistry,
  startTestGatewayServer,
} from "../test-helpers.js";
import type { CanonicalGatewayReadinessResult } from "./readiness.js";

const reload = vi.hoisted(() => ({
  params: undefined as ManagedGatewayConfigReloaderParams | undefined,
}));

vi.mock("../server-reload-managed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server-reload-managed.js")>();
  return {
    ...actual,
    startManagedGatewayConfigReloader: (params: ManagedGatewayConfigReloaderParams) => {
      reload.params = params;
      return actual.startManagedGatewayConfigReloader(params);
    },
  };
});

installGatewayTestHooks();

describe("Gateway readiness config replacement", () => {
  it("quarantines abort-ignoring work and fences stale success at /readyz", async () => {
    type Check = PluginReadinessCriterionRegistration["criterion"]["check"];
    type Result = Awaited<ReturnType<Check>>;
    const success: Result = {
      status: "True",
      reason: "StorageReady",
      message: "Storage is ready.",
    };
    const unavailable: Result = {
      status: "False",
      reason: "StorageUnavailable",
      message: "Replacement storage is unavailable.",
    };
    const retired = createDeferredCore<Result>();
    let retiredConfig: OpenClawConfig | undefined;
    let replacementConfig: OpenClawConfig | undefined;
    let retiredSignal: AbortSignal | undefined;
    let active = 0;
    let maxActive = 0;
    const check = vi.fn<Check>(async ({ config, signal }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (config === retiredConfig) {
          retiredSignal = signal;
          // Deliberately ignore abort: only settling this raw promise releases ownership.
          return await retired.promise;
        }
        return config === replacementConfig ? unavailable : success;
      } finally {
        active -= 1;
      }
    });
    const registry = createEmptyPluginRegistry();
    registry.readinessCriteria.push({
      id: "plugin.storage.backend",
      pluginId: "storage",
      source: "/synthetic/storage/index.js",
      criterion: { id: "backend", description: "Storage availability.", check },
    });
    setTestPluginRegistry(registry);

    let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
    let oldRequest:
      | Promise<{
          status: number;
          body: CanonicalGatewayReadinessResult;
        }>
      | undefined;
    try {
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
      }
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: {
            reload: { mode: "off" },
            readiness: { requiredCriteria: ["plugin.storage.backend"] },
          },
        }),
      );
      const port = await getGatewayTestPort();
      server = await startTestGatewayServer(port);
      await server.startupSettled;
      const probe = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.timeout(5_000),
        });
        return {
          status: response.status,
          body: (await response.json()) as CanonicalGatewayReadinessResult,
        };
      };
      const expectStorage = (
        response: Awaited<ReturnType<typeof probe>>,
        status: "True" | "False" | "Unknown",
        reason: string,
      ) => {
        expect(response.status).toBe(status === "True" ? 200 : 503);
        expect(response.body.ready).toBe(status === "True");
        expect(response.body.conditions).toContainEqual(
          expect.objectContaining({
            type: "plugin.storage.backend",
            subjectRef: "plugin.storage/criterion/backend",
            requirement: "required",
            status,
            reason,
          }),
        );
      };

      expectStorage(await probe(), "True", "StorageReady");
      check.mockClear();
      const params = reload.params;
      if (!params) {
        throw new Error("Gateway did not register its managed config reloader");
      }
      // The harness mocks plugin loading/config IO and skips managed transactions.
      // Invoke the production startup-registered commit callback, not a copied fence.
      // The registry stays stable; distinct committed config objects replace its owner.
      retiredConfig = structuredClone(params.initialConfig);
      params.commitRuntimePolicy(retiredConfig);
      oldRequest = probe();
      // Observe early transport failure while preserving the original promise for assertions.
      void oldRequest.catch(() => {});
      await vi.waitFor(() => expect(retiredSignal).toBeDefined(), {
        timeout: 2_000,
        interval: 10,
      });
      expect(active).toBe(1);
      expect(retiredSignal?.aborted).toBe(false);

      replacementConfig = structuredClone(retiredConfig);
      params.commitRuntimePolicy(replacementConfig);
      expectStorage(await probe(), "Unknown", "CriterionPreviousEvaluationPending");
      expectStorage(await probe(), "Unknown", "CriterionPreviousEvaluationPending");
      expect(retiredSignal?.aborted).toBe(true);
      expect(check).toHaveBeenCalledTimes(1);
      expect(active).toBe(1);
      expect(maxActive).toBe(1);

      retired.resolve(success);
      // This request began under the retired owner. Its late success must be discarded.
      expectStorage(await oldRequest, "False", "StorageUnavailable");
      expect(check).toHaveBeenCalledTimes(2);
      expect(check.mock.calls[1]?.[0].config).toBe(replacementConfig);
      expect(active).toBe(0);
      expectStorage(await probe(), "False", "StorageUnavailable");
      expect(check).toHaveBeenCalledTimes(2);

      params.commitRuntimePolicy(structuredClone(replacementConfig));
      expectStorage(await probe(), "True", "StorageReady");
      expect(check).toHaveBeenCalledTimes(3);
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
    } finally {
      retired.resolve(success);
      await oldRequest?.catch(() => {});
      try {
        await server?.close();
      } finally {
        reload.params = undefined;
        resetTestPluginRegistry();
      }
    }
  });
});
