import { expect, it } from "vitest";
import { replyToolDiscoveryCapture } from "./reply-tool-discovery-capture.js";

const gatewayCapture = { kind: "clear" as const, assertCurrent: () => undefined };

it("clears saved presentation for a fresh human channel turn", () => {
  expect(replyToolDiscoveryCapture(undefined, {}, true).toolDiscoveryCapture?.kind).toBe("clear");
});

it.each([
  ["Gateway ingress without its own capture", undefined, { GatewayClientScopes: [] }, true],
  ["an internal event", { internalEventExecution: {} }, {}, true],
  ["a room event, scheduled or handed-off turn", undefined, {}, false],
] as const)("leaves %s to its existing presentation owner", (_case, opts, ctx, fresh) => {
  expect(replyToolDiscoveryCapture(opts, ctx, fresh)).toEqual({});
});

it("keeps the Gateway requester's own capture", () => {
  expect(replyToolDiscoveryCapture({ toolDiscoveryCapture: gatewayCapture }, {}, true)).toEqual({
    toolDiscoveryCapture: gatewayCapture,
  });
});
