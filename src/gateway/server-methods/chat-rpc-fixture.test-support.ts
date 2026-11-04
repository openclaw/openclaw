import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export async function chatRpc(
  context: GatewayRequestContext,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: `proof-${method}`, method, params },
    respond,
    client,
    context,
    signal,
    isWebchatConnect: () => true,
  });
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "RPC response");
}
