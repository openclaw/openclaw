import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
afterAll(async () => {
  await state?.cleanup();
});

const services = new Set<PluginServicesHandle>();
afterEach(async () => {
  await Promise.all([...services].map((service) => service.stop()));
  services.clear();
});

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
  bindGatewayControlUiIngressHost(resolveContext, {
    controlUiBasePath: "",
    getResolvedAuth: () => ({
      mode: "token",
      token: "synthetic-test-token",
      allowTailscale: false,
    }),
    getRuntimeConfig: () => ({
      gateway: { auth: { mode: "token", token: "synthetic-test-token" } },
    }),
    handleRequest: async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("synthetic Control UI");
    },
    handleSandboxRequest: async (_req, res) => {
      res.end("synthetic sandbox");
    },
    handleUpgrade: async (_req, socket) => {
      socket.destroy();
    },
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
  services.add(service);
  if (!serviceContext) {
    throw new Error("Service did not start");
  }
  return { service, serviceContext, registry, record };
}

function openOptions(): GatewayControlUiIngressOpenOptionsV2 {
  return {
    audienceId: "synthetic-grant",
    principal: { kind: "owner" },
    publicOrigin: "https://ui.example.com",
    sandboxOrigin: "https://sandbox.example.com",
    frameAncestors: ["https://host.example.com"],
    operatorScopeCeiling: ["operator.read"],
    signal: new AbortController().signal,
    assertCurrent: () => {},
  };
}

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

describe("service Control UI ingress authority", () => {
  it.each([
    { origin: "bundled" as const, available: true },
    { origin: "global" as const, trustedOfficialInstall: true, available: true },
    { origin: "global" as const, available: false },
    { origin: "workspace" as const, available: false },
  ])(
    "uses admitted provenance for $origin (available=$available)",
    async ({ available, ...record }) => {
      const { serviceContext } = await fixture(record);
      expect(serviceContext.controlUiIngress !== undefined).toBe(available);
      expect(serviceContext.controlUiIngress?.capabilityVersion).toBe(available ? 2 : undefined);
    },
  );

  it("revokes retained authority when the service stops", async () => {
    const { service, serviceContext } = await fixture();
    const factory = serviceContext.controlUiIngress!;
    const ingress = await factory.open(openOptions());
    const rpc = await factory.bindPrincipal(openOptions());
    expect(await readUi(ingress)).toBe("synthetic Control UI");
    await service.stop();
    await expect(factory.open(openOptions())).rejects.toThrow(/stopped|active|closed/);
    await expect(rpc.request("users.self", {})).rejects.toThrow(/stopped|active|closed/);
    await expect(readUi(ingress)).rejects.toThrow(/stopped|active|closed/);
  });

  it("refuses retained authority after its plugin record is revoked", async () => {
    const { serviceContext, registry, record } = await fixture();
    const factory = serviceContext.controlUiIngress!;
    const ingress = await factory.open(openOptions());
    const rpc = await factory.bindPrincipal(openOptions());
    revokePluginRecord(registry, record);
    await expect(factory.open(openOptions())).rejects.toThrow(/active/);
    await expect(rpc.request("users.self", {})).rejects.toThrow(/active/);
    await expect(readUi(ingress)).rejects.toThrow(/active/);
  });
});
