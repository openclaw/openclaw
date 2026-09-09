/* @vitest-environment jsdom */

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { page } from "./route.ts";

it("loads Devices from the connection current after the route module yield", async () => {
  const response = (nodeId: string) => async (method: string) => {
    if (method === "node.list") {
      return { nodes: [{ id: nodeId }] };
    }
    if (method === "device.pair.list") {
      return { pending: [], paired: [] };
    }
    if (method === "exec.approvals.get") {
      return { hash: "fixture", file: { version: 1 } };
    }
    throw new Error(`Unexpected Devices request: ${method}`);
  };
  const oldRequest = vi.fn(response("old-node"));
  const currentRequest = vi.fn(response("current-node"));
  const oldClient = createTestGatewayClient(oldRequest);
  const currentClient = createTestGatewayClient(currentRequest);
  const harness = createApplicationGateway({
    client: oldClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  });
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  onTestFinished(runtimeConfig.dispose);
  const refresh = vi.spyOn(runtimeConfig, "refresh").mockResolvedValue(undefined);
  const context = {
    gateway: harness.gateway,
    runtimeConfig,
  } as ApplicationContext;

  if (!page.loader) {
    throw new Error("Devices route has no loader");
  }
  const pending = page.loader(context, {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: { pathname: "/devices", search: "", hash: "" },
    deps: "",
    cause: "navigation",
  } satisfies RouteLoaderOptions);
  harness.publish({ ...harness.gateway.snapshot, client: currentClient });
  const data = await pending;

  expect(oldRequest).not.toHaveBeenCalled();
  expect(currentRequest).toHaveBeenCalledWith("node.list", {});
  expect(refresh).toHaveBeenCalledOnce();
  expect(data).toMatchObject({
    gateway: harness.gateway,
    gatewaySnapshot: harness.gateway.snapshot,
    devices: { client: currentClient, nodes: [{ id: "current-node" }] },
  });
});
