import { expect, it, vi } from "vitest";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { createGatewayNodesRuntime } from "./server-plugins.js";

const handleGatewayRequest = vi.hoisted(() => vi.fn(async (_options: GatewayRequestOptions) => {}));
// mock-isolation: only the terminal dispatch is replaced; runtime scope and authority preparation are real.
vi.mock("./server-methods.js", () => ({ handleGatewayRequest }));

it("retains node effect authority through asynchronous plugin dispatch", async () => {
  const context = {
    getRuntimeConfig: () => ({}),
    trackExecution: trackAsyncWork,
  } as GatewayRequestContext;
  const nodes = createGatewayNodesRuntime(() => context);
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("target grant revoked");
    }
  };
  const revalidate = vi.fn(async () => {
    await Promise.resolve();
    assertCurrent();
  });
  handleGatewayRequest.mockImplementationOnce(async (options) => {
    expect(options.req.params).not.toHaveProperty("nodeDispatchAuthority");
    const authority = options.nodeDispatchAuthority;
    expect(authority).toBeDefined();
    await expect(authority!.prepare()).resolves.toBe(true);
    current = false;
    expect(() => authority!.assertCurrent()).toThrow("target grant revoked");
    await expect(authority!.prepare()).rejects.toThrow("target grant revoked");
    options.respond(true, { blocked: true });
  });
  await withPluginRuntimeGatewayRequestScope(
    { context, isWebchatConnect: () => false, revalidate },
    () =>
      withPluginRuntimePluginScope({ pluginId: "device-controls", pluginOrigin: "bundled" }, () =>
        nodes.invoke({ nodeId: "node-1", command: "device-controls.audio", assertCurrent }),
      ),
  );
  expect(handleGatewayRequest).toHaveBeenCalledOnce();
  expect(revalidate).toHaveBeenCalledTimes(2);
});
