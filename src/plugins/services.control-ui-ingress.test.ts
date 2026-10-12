import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { bindGatewayControlUiIngressHost } from "../gateway/remote-control-ui-ingress-host.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type {
  GatewayControlUiIngressFactoryV1,
  GatewayControlUiIngressFactoryV2,
  GatewayControlUiIngressOpenOptionsV2,
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

async function fixture(recordOptions: Partial<PluginRecord> = {}, stop?: () => Promise<void>) {
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
      stop,
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

describe("service Control UI ingress authority", () => {
  it("refuses a legacy host before it can interpret a person grant as owner authority", async () => {
    let legacyOpened = false;
    const legacy: GatewayControlUiIngressFactoryV1 = {
      async open() {
        legacyOpened = true;
        throw new Error("Legacy owner open called");
      },
    };
    const openPerson = async (
      factory: GatewayControlUiIngressFactoryV1 | GatewayControlUiIngressFactoryV2,
    ) => {
      if (!("capabilityVersion" in factory) || factory.capabilityVersion !== 2) {
        throw new Error("Upgrade OpenClaw: principal-bound ingress requires capability version 2.");
      }
      return factory.open({
        ...openOptions(),
        principal: { kind: "person", profileId: "approved-person" },
      });
    };
    await expect(openPerson(legacy)).rejects.toThrow("requires capability version 2");
    expect(legacyOpened).toBe(false);
  });

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
      if (serviceContext.controlUiIngress) {
        expect(serviceContext.controlUiIngress.capabilityVersion).toBe(2);
        const ingress = await serviceContext.controlUiIngress.open(openOptions());
        const { response } = await ingress.request({
          surface: "control-ui",
          method: "GET",
          pathAndQuery: "/",
          headers: [["accept", "text/html"]],
          signal: new AbortController().signal,
        });
        expect(await response.text()).toBe("synthetic Control UI");
        await ingress.close();
      }
    },
  );

  it("fences retained handles before asynchronous plugin cleanup settles", async () => {
    const enteredStop = createDeferred();
    const releaseStop = createDeferred();
    const { service, serviceContext } = await fixture({}, async () => {
      enteredStop.resolve();
      await releaseStop.promise;
    });
    const factory = serviceContext.controlUiIngress!;
    let stopping: Promise<unknown> | undefined;
    try {
      const ingress = await factory.open(openOptions());
      const rpc = await factory.bindPrincipal(openOptions());
      stopping = service.stop();
      await awaitGateBeforeSettlement(
        enteredStop.promise,
        stopping,
        "Service stopped before its cleanup",
      );
      await expect(factory.open(openOptions())).rejects.toThrow(/stopped|active|closed/);
      await expect(rpc.request("users.self", {})).rejects.toThrow(/stopped|active|closed/);
      await expect(
        ingress.request({
          surface: "control-ui",
          method: "GET",
          pathAndQuery: "/",
          headers: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/stopped|active|closed/);
    } finally {
      releaseStop.resolve();
      await stopping;
    }
  });

  it("refuses retained authority after its plugin record is revoked", async () => {
    const { serviceContext, registry, record } = await fixture();
    const factory = serviceContext.controlUiIngress!;
    const ingress = await factory.open(openOptions());
    const rpc = await factory.bindPrincipal(openOptions());
    revokePluginRecord(registry, record);
    await expect(factory.open(openOptions())).rejects.toThrow(/active/);
    await expect(rpc.request("users.self", {})).rejects.toThrow(/active/);
    await expect(
      ingress.request({
        surface: "control-ui",
        method: "GET",
        pathAndQuery: "/",
        headers: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/active/);
  });
});
