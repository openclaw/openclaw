import { expect, vi } from "vitest";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export function sessionReader(context: GatewayRequestContext, client: GatewayClient, key: string) {
  return async (
    method: "sessions.describe" | "sessions.get" = "sessions.describe",
    limit?: number,
  ) => {
    const respond = vi.fn<RespondFn>();
    await sessionByKeyReadHandlers[method]!({
      req: { type: "req", id: "keyed-read", method },
      params: { key, ...(limit === undefined ? {} : { limit }) },
      context,
      client,
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    return respond.mock.calls[0]?.[1];
  };
}
