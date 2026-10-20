import assert from "node:assert/strict";
import { queryObjects } from "node:v8";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { bindGatewayControlUiIngressHost } from "../gateway/remote-control-ui-ingress-host.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type {
  GatewayControlUiIngressOpenOptionsV2,
  GatewayControlUiIngressV2,
} from "./gateway-ingress.types.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, revokePluginRecord } from "./registry-lifecycle.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRecord } from "./registry-types.js";
import { bindGatewayContextResolver } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { startPluginServices, type PluginServicesHandle } from "./services.test-support.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginServiceContext } from "./types.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "ingress-capability", layout: "state-only" });
});
afterAll(() => state?.cleanup());

async function fixture(recordOptions: Partial<PluginRecord> = {}) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "ingress-test", origin: "bundled", ...recordOptions });
  registry.plugins.push(record);
  const context = {
    trackExecution: trackAsyncWork,
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
  const resolveContext = () => context;
  context.resolveGatewayContext = resolveContext;
  const subagent = {} as PluginRuntime["subagent"];
  bindGatewayContextResolver(subagent, resolveContext);
  bindPluginRegistryRuntime(registry, createLazyPluginRuntime({ runtimeOptions: { subagent } }));
  const token = "synthetic-test-token";
  bindGatewayControlUiIngressHost(resolveContext, {
    controlUiBasePath: "",
    getResolvedAuth: () => ({ mode: "token", token, allowTailscale: false }),
    getRuntimeConfig: () => ({ gateway: { auth: { mode: "token", token } } }),
    handleRequest: async (_req, res) =>
      void res.setHeader("Content-Type", "text/html").end("synthetic Control UI"),
    handleSandboxRequest: async (_req, res) => void res.end("synthetic sandbox"),
    handleUpgrade: async (_req, socket) => void socket.destroy(),
    signal: new AbortController().signal,
  });
  markPluginRegistryActive(registry);
  let serviceContext: OpenClawPluginServiceContext | undefined;
  registry.services.push({
    id: "ingress-service",
    pluginId: record.id,
    source: record.source,
    origin: record.origin,
    service: {
      id: "ingress-service",
      start: (ctx) => {
        serviceContext = ctx;
      },
    },
  });
  const service = await startPluginServices({ registry, config: {} });
  onTestFinished(() => service.stop());
  assert(serviceContext, "Service did not start");
  return { service, serviceContext, registry, record };
}

const openOptions = (): GatewayControlUiIngressOpenOptionsV2 => ({
  audienceId: "synthetic-grant",
  principal: { kind: "owner" },
  publicOrigin: "https://ui.example.com",
  sandboxOrigin: "https://sandbox.example.com",
  frameAncestors: ["https://host.example.com"],
  operatorScopeCeiling: ["operator.read"],
  signal: new AbortController().signal,
  assertCurrent: () => {},
});

async function readUi(ingress: GatewayControlUiIngressV2) {
  const { response } = await ingress.request({
    surface: "control-ui",
    method: "GET",
    pathAndQuery: "/",
    headers: [],
    signal: new AbortController().signal,
  });
  return response.text();
}

it.each([
  { origin: "bundled" as const, available: true },
  { origin: "global" as const, trustedOfficialInstall: true, available: true },
  { origin: "global" as const, available: false },
  { origin: "workspace" as const, available: false },
])("ingress provenance: $origin/$available", async ({ available, ...record }) => {
  const { serviceContext } = await fixture(record);
  expect(serviceContext.controlUiIngress).toEqual(
    available ? expect.objectContaining({ capabilityVersion: 2 }) : undefined,
  );
});

it.each(["stop", "revoke"])("revokes retained ingress authority on %s", async (action) => {
  class RetiringCaller {
    stop(service: PluginServicesHandle) {
      return service.stop();
    }
  }
  const { service, serviceContext, registry, record } = await fixture();
  const factory = serviceContext.controlUiIngress!;
  const ingress = await factory.open(openOptions());
  const rpc = await factory.bindPrincipal(openOptions());
  expect(await readUi(ingress)).toBe("synthetic Control UI");
  if (action === "stop") {
    await new RetiringCaller().stop(service);
    // Collect before error matchers materialize the abort reason's stack.
    expect(queryObjects(RetiringCaller)).toBe(0);
  } else {
    revokePluginRecord(registry, record);
  }
  const reason = action === "stop" ? /stopped|active|closed/ : /active/;
  await expect(factory.open(openOptions())).rejects.toThrow(reason);
  await expect(rpc.request("users.self", {})).rejects.toThrow(reason);
  await expect(readUi(ingress)).rejects.toThrow(reason);
});
