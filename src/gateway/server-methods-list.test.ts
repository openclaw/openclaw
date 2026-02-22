import { describe, expect, it } from "vitest";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";

// "connect" is the WebSocket handshake handler, not a client-callable RPC method.
const INTERNAL_METHODS = new Set(["connect"]);

describe("listGatewayMethods", () => {
  it("includes all core handler methods", () => {
    const methods = listGatewayMethods();
    const handlerMethods = Object.keys(coreGatewayHandlers).filter((m) => !INTERNAL_METHODS.has(m));
    const missing = handlerMethods.filter((m) => !methods.includes(m));
    expect(missing).toEqual([]);
  });
});
