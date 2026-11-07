/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
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
  const harness = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: oldClient,
      phase: "connected",
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
    }),
  );
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
  const pending = page.loader(
    context,
    createRouteLoaderOptions({ pathname: "/devices", search: "", hash: "" }),
  );
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

it("does not start Devices reads after navigation leaves during the module load", async () => {
  const request = vi.fn(async () => ({ nodes: [], pending: [], paired: [] }));
  const harness = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: createTestGatewayClient(request),
      phase: "connected",
    }),
  );
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  onTestFinished(() => runtimeConfig.dispose());
  const refresh = vi.spyOn(runtimeConfig, "refresh").mockResolvedValue(undefined);
  // SAFETY: The Devices loader only reads the Gateway and runtime config capabilities.
  const context = { gateway: harness.gateway, runtimeConfig } as ApplicationContext;
  const controller = new AbortController();
  const options = {
    ...createRouteLoaderOptions({ pathname: "/devices", search: "", hash: "" }),
    signal: controller.signal,
    shouldRun: () => !controller.signal.aborted,
  };
  if (!page.loader) {
    throw new Error("Devices route has no loader");
  }
  const pending = page.loader(context, options);
  controller.abort(new Error("superseded navigation"));
  await Promise.resolve(pending).catch(() => undefined);

  expect(request).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});
