import { vi } from "vitest";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

/** Captures the callback-style gateway response tuple for handler tests. */
export type CapturedGatewayResponse = {
  ok: boolean | null;
  response: unknown;
  error: unknown;
};

function makeGatewayHandlerTestContext(): GatewayRequestContext {
  // Skill handler tests exercise method dispatch only, so keep the context to the fields they read.
  return {
    getRuntimeConfig: () => ({}),
    logGateway: vi.fn(),
  } as unknown as GatewayRequestContext;
}

/** Invoke a server-method handler through the real request shape and capture respond() output. */
export async function callGatewayHandler(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
): Promise<CapturedGatewayResponse> {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  const handler = handlers[method];

  if (!handler) {
    throw new Error(`unknown gateway handler: ${method}`);
  }

  await handler({
    params,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
    context: makeGatewayHandlerTestContext(),
    respond: (success, result, err) => {
      ok = success;
      response = result;
      error = err;
    },
  });

  return { ok, response, error };
}
