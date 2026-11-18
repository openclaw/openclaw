import { expectDefined } from "@openclaw/normalization-core/expect";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/shared-types.js";

type DirectChatMethod = "chat.abort" | "chat.history" | "chat.send" | "chat.startup";

export async function callDirectChatHandler(
  method: DirectChatMethod,
  options: GatewayRequestHandlerOptions,
) {
  const { coreGatewayHandlers } = await import("./server-methods.js");
  if (method === "chat.history" || method === "chat.startup") {
    await initializeSessionReadContext(options.context);
  }
  await expectDefined(coreGatewayHandlers[method], `${method} test invariant`)(options);
}

type DirectChatCallOptions = Omit<
  GatewayRequestHandlerOptions,
  "client" | "isWebchatConnect" | "req"
> & {
  id: string;
  client?: GatewayRequestHandlerOptions["client"];
  isWebchatConnect?: GatewayRequestHandlerOptions["isWebchatConnect"];
  req?: GatewayRequestHandlerOptions["req"];
};

export async function callDirectChat(method: DirectChatMethod, options: DirectChatCallOptions) {
  const { client, id, isWebchatConnect, req, ...handlerOptions } = options;
  await callDirectChatHandler(method, {
    ...handlerOptions,
    req: req ?? { type: "req", id, method, params: options.params },
    client: client ?? null,
    isWebchatConnect: isWebchatConnect ?? (() => false),
  });
}
