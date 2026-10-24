import { expect, vi } from "vitest";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayRequestEntryLifetime } from "../server-request-entry.js";
import type { GatewayRequestOptions } from "./types.js";

export function profileRequest(
  options: {
    method?:
      | "diagnostics.cpuProfile"
      | "diagnostics.heapProfile"
      | "diagnostics.heapSnapshot"
      | "diagnostics.capabilities";
    scopes?: string[];
    role?: string;
    params?: unknown;
    connection?: AbortController;
    gateway?: GatewayRequestEntryLifetime;
    signal?: AbortSignal;
    hasAuthority?: () => boolean;
  } = {},
) {
  const respond = vi.fn();
  const pending = handleGatewayRequest({
    req: {
      type: "req",
      id: "profile",
      method: options.method ?? "diagnostics.cpuProfile",
      params: options.params,
    },
    respond,
    client: {
      connId: "profile-client",
      connectionSignal: options.connection?.signal,
      connect: {
        role: options.role ?? "operator",
        scopes: options.scopes ?? ["operator.admin"],
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
      },
    } as GatewayRequestOptions["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
      requestEntryLifetime: options.gateway,
    } as unknown as GatewayRequestOptions["context"],
    signal: options.signal,
    hasCurrentClientAuthority: options.hasAuthority,
  });
  return { respond, pending };
}

export function expectProfileError(
  call: ReturnType<typeof profileRequest>,
  error: Record<string, unknown>,
) {
  expect(call.respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}
