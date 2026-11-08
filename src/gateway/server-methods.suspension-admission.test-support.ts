import { vi } from "vitest";
import { createCoreGatewayMethodDescriptors } from "./methods/core-method-policy.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";

export function dispatchSuspensionRequest(params: {
  method: string;
  scope: "operator.read" | "operator.write" | "operator.admin";
  handler: GatewayRequestHandler;
  requestParams?: unknown;
  context?: Parameters<typeof handleGatewayRequest>[0]["context"];
  core?: boolean;
  clientScopes?: string[];
}) {
  const respond = vi.fn();
  const methodRegistry = createGatewayMethodRegistry(
    params.core
      ? createCoreGatewayMethodDescriptors({ [params.method]: params.handler })
      : [
          createPluginGatewayMethodDescriptor({
            pluginId: "suspend-proof",
            name: params.method,
            handler: params.handler,
            scope: params.scope,
          }),
        ],
  );
  const request = handleGatewayRequest({
    req: {
      type: "req",
      id: `request-${params.method}`,
      method: params.method,
      params: params.requestParams ?? {},
    },
    respond,
    client: {
      connId: "conn-suspend-proof",
      connect: gatewayConnect(params.clientScopes ?? [params.scope], {
        id: "cli",
        platform: "linux",
        mode: "cli",
      }),
    },
    isWebchatConnect: () => false,
    context:
      params.context ??
      ({
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn(), info: vi.fn() },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"]),
    methodRegistry,
  });
  return { request, respond };
}
