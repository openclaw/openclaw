import { vi } from "vitest";
import { createCoreGatewayMethodDescriptors } from "./methods/core-method-policy.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

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
      connect: {
        role: "operator",
        scopes: params.clientScopes ?? [params.scope],
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context:
      params.context ??
      ({ logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"]),
    methodRegistry,
  });
  return { request, respond };
}
