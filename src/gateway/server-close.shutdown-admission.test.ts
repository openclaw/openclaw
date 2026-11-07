import { expect, it, vi } from "vitest";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createServiceRegistration,
  startPluginServices,
} from "../plugins/services.test-support.js";
import type { OpenClawPluginService } from "../plugins/types.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import type {
  GatewayCloseParams as GatewayTeardownParams,
  GatewayClosePrepareParams,
} from "./server-close.js";
import { createGatewayCloseTestDepsFactory } from "./server-close.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayCloseOptions } from "./server-public.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";

const { mocks } = await vi.hoisted(() => import("./server-close.mocks.test-support.js"));

const { prepareGatewayClose, completeGatewayClose } = await import("./server-close.js");
type GatewayCloseParams = GatewayTeardownParams & GatewayClosePrepareParams;
function createGatewayCloseHandler(params: GatewayCloseParams) {
  return async (opts?: GatewayCloseOptions) =>
    completeGatewayClose(params, await prepareGatewayClose(params, opts));
}

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory(mocks);

// Registered server.close, routed by vitest.gateway-server.config.ts to gateway-server.
it("keeps plugin service cleanup admitted after restart draining fences ordinary requests", async () => {
  const probeResults: boolean[] = [];
  const requestEntryLifetime = new GatewayRequestEntryLifetime();
  const enterAsExternalRequest = () =>
    requestEntryLifetime.enter({
      req: { method: "browser.request", params: {} },
      client: null,
      context: { trackExecution: trackAsyncWork } as GatewayRequestContext,
    });
  const instance = new PluginInstance("shutdown-admission-probe");
  const service = instance.wrap<OpenClawPluginService>({
    id: "shutdown-admission-probe",
    start: async () => {},
    stop: async () => {
      // Real request-entry boundary: the close prelude already aborted the
      // entry lifetime, so this enter (and the nested router probe) succeeds
      // only while the chain owns the shutdown cleanup root — the same path a
      // Meet drain's browser.request/voicecall.end dispatch takes.
      enterAsExternalRequest().release();
      const nested = tryBeginGatewayRootWorkAdmission("ws:browser.request");
      probeResults.push(nested !== null);
      nested?.release();
    },
  });
  const registry = createEmptyPluginRegistry();
  registry.services.push(
    createServiceRegistration(service, {
      pluginId: "shutdown-admission-probe",
      origin: "bundled",
    }),
  );
  setActivePluginRegistry(registry);
  const pluginServices = await startPluginServices({ registry, config: {} });
  markGatewayRestartDraining("restart (SIGTERM)");
  // The real close prelude aborts request entry before prepare/complete close.
  requestEntryLifetime.beginClose();
  try {
    // Ordinary new roots stay fenced for the whole drain, and external
    // request entry stays closed.
    expect(tryBeginGatewayRootWorkAdmission("ws:browser.request")).toBeNull();
    expect(enterAsExternalRequest).toThrow("Gateway request entry is closed");
    const result = await createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        pluginServices,
        finishRequestEntries: () => requestEntryLifetime.sealAndJoin(),
      }),
    )({
      reason: "restart",
    });
    expect(result.warnings).toStrictEqual([]);
    expect(probeResults).toEqual([true]);
    // External requests stay fenced after cleanup as well.
    expect(enterAsExternalRequest).toThrow("Gateway request entry is closed");
  } finally {
    resetGatewayWorkAdmission();
    await pluginServices.stop().catch(() => {});
    await instance.dispose();
    await clearActivePluginRegistry();
  }
});
