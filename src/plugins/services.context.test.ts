import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../gateway/operator-tool-gateway-authority.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import {
  bindGatewayContextResolver,
  getInProcessGatewayRequestContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import { startPluginServices } from "./services.js";

it("starts and reloads background services outside the RPC and tool authority", async () => {
  const runtime = createPluginRuntime();
  const context = createGatewayRequestContext(makeContextParams());
  bindGatewayContextResolver(runtime, () => context);
  const registry = createEmptyPluginRegistry();
  bindPluginRegistryRuntime(registry, runtime);
  const callbacks: Array<() => void> = [];
  const broadcastPluginEvent = vi.fn();
  registry.services.push({
    id: "background",
    pluginId: "background",
    origin: "bundled",
    source: "synthetic",
    service: {
      id: "background",
      start(ctx) {
        const runBackground = AsyncLocalStorage.snapshot();
        callbacks.push(() =>
          runBackground(() => {
            readOperatorToolGatewayAuthority()?.signal.throwIfAborted();
            expect(getPluginRuntimeGatewayRequestScope()?.client).toBeUndefined();
            expect(getInProcessGatewayRequestContext()).toBe(context);
            ctx.gatewayEvents?.emit("changed", {}, { scope: "operator.read" });
          }),
        );
      },
    },
  });
  const callerLifetime = new AbortController();
  const inCaller = <T>(run: () => T) =>
    runWithOperatorToolGatewayAuthority(
      {
        signal: callerLifetime.signal,
        scopes: ["operator.read"],
        operatorRoleActor: { kind: "system" },
      },
      () =>
        withPluginRuntimeGatewayRequestScope(
          {
            context,
            client: createSyntheticPluginRuntimeClient({ scopes: ["operator.read"] }),
            signal: callerLifetime.signal,
            isWebchatConnect: () => false,
          },
          run,
        ),
    );
  const handle = await inCaller(() =>
    startPluginServices({ registry, config: {}, broadcastPluginEvent }),
  );
  try {
    await inCaller(() => handle.reload({}, new Set(["background"])));
    callerLifetime.abort(new Error("Originating tool settled"));
    expect(callbacks).toHaveLength(2);
    expect(() => callbacks[0]?.()).toThrow("no longer active");
    callbacks[1]?.();
    expect(broadcastPluginEvent).toHaveBeenCalledTimes(1);
    await handle.stop();
    expect(() => callbacks[1]?.()).toThrow("no longer active");
  } finally {
    await handle.stop();
  }
});
