/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";

it("retains display identity until reconnect resolves or the connection changes", () => {
  const user = { id: "reader", name: "Reader" };
  const { gateway } = createApplicationGateway({
    client: null,
    phase: "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
    selfUser: user,
  });
  const original = gatewayPresentationScope(gateway);
  for (const phase of ["reconnecting", "connected"] as const) {
    gateway.snapshot.phase = phase;
    gateway.snapshot.selfUser = undefined;
    expect(gatewayPresentationScope(gateway)).toBe(original);
    expect(original.displayUser).toEqual(user);
  }
  gateway.snapshot.selfUser = null;
  expect(gatewayPresentationScope(gateway).displayUser).toBeNull();

  gateway.snapshot.selfUser = user;
  gatewayPresentationScope(gateway);
  Object.assign(gateway, { connectionRevision: 1 });
  gateway.snapshot.selfUser = undefined;
  const replacement = gatewayPresentationScope(gateway);
  expect(replacement).not.toBe(original);
  expect(replacement.displayUser).toBeNull();
});
