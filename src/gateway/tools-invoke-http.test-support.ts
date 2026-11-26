import type { IncomingMessage, ServerResponse } from "node:http";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import {
  withOpenClawTestState as withTestState,
  type OpenClawTestState as TestState,
} from "../test-utils/openclaw-test-state.js";
import { createTestGatewayHttpServer } from "./http-server.test-support.js";
import type { GatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import type { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

export function withToolsInvokeTestState<T>(
  options: Parameters<typeof withTestState>[0],
  run: (state: TestState) => Promise<T>,
): Promise<T> {
  return withTestState(options, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    return await run(state);
  });
}

export function createToolsInvokeHttpTestServer(params: {
  handleToolsInvoke: typeof handleToolsInvokeHttpRequest;
  getPluginHandlers?: () => ReadonlyArray<
    (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  >;
}) {
  let resolveGatewayContext: GatewayContextResolver | undefined;
  const server = createTestGatewayHttpServer(async (req, res) => {
    if (
      await params.handleToolsInvoke(req, res, {
        auth: { mode: "none", allowTailscale: false },
        resolveGatewayContext,
      })
    ) {
      return true;
    }
    for (const handler of params.getPluginHandlers?.() ?? []) {
      if (await handler(req, res)) {
        return true;
      }
    }
    return false;
  });
  return {
    ...server,
    setMethodRegistry(this: void, registry: GatewayMethodRegistry) {
      const context = resolveGatewayContext?.();
      if (!context) {
        throw new Error("Expected initialized Gateway context");
      }
      context.getGatewayMethodRegistry = () => registry;
    },
    resetContext() {
      const context = createGatewayRequestContext(makeContextParams());
      resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
    },
  };
}
