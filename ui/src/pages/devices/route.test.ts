/* @vitest-environment jsdom */

import { createRouter, type RouteLoaderOptions } from "@openclaw/uirouter";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { DevicesRouteData } from "./devices-page.ts";
import "./devices-page.ts";
import { page } from "./route.ts";

it.each([
  { name: "empty", nodes: [], failFirst: false },
  { name: "populated", nodes: [{ nodeId: "fixture-node" }], failFirst: false },
  { name: "failed", nodes: [], failFirst: true },
])("initializes $name node inventory from route results", async ({ nodes, failFirst }) => {
  let nodeReads = 0;
  const client = createTestGatewayClient(
    vi.fn(async (method: string) => {
      if (method === "node.list") {
        nodeReads += 1;
        if (failFirst && nodeReads === 1) {
          throw new Error("Synthetic initial read failure");
        }
        return { nodes };
      }
      if (method === "system-presence") {
        return [];
      }
      if (method === "exec.approvals.get") {
        return { hash: "fixture", file: { version: 1 } };
      }
      return { pending: [], paired: [] };
    }),
  );
  const harness = createApplicationGateway({
    client,
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
  onTestFinished(() => runtimeConfig.dispose());
  vi.spyOn(runtimeConfig, "refresh").mockResolvedValue(undefined);
  const context = { gateway: harness.gateway, runtimeConfig } as ApplicationContext;
  const element = document.createElement("openclaw-devices-page") as HTMLElement & {
    context: ApplicationContext;
    routeData?: DevicesRouteData;
    pageState: DevicesRouteData["devices"];
    updateComplete: Promise<boolean>;
  };
  onTestFinished(() => element.remove());
  element.context = context;
  const router = createRouter({ routes: [page] });
  onTestFinished(() => router.stop());
  await router.navigate(page.id, context);
  expect(router.getState().status).toBe("success");
  element.routeData = router.getState().matches[0]?.data;
  document.body.append(element);
  await element.updateComplete;
  await vi.waitFor(() => expect(element.pageState.nodesLoading).toBe(false));
  expect(element.pageState.nodes).toEqual(nodes);
  expect(element.pageState.lastError).toBeNull();
  expect(nodeReads).toBe(failFirst ? 2 : 1);

  // Revalidation replaces route data on the same page after a cached result.
  await router.revalidate(context, page.id);
  expect(router.getState().status).toBe("success");
  element.routeData = router.getState().matches[0]?.data;
  await element.updateComplete;
  await vi.waitFor(() => expect(element.pageState.nodesLoading).toBe(false));
  expect(nodeReads).toBe(failFirst ? 3 : 2);
});

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
  onTestFinished(() => runtimeConfig.dispose());
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
