import type { GatewayPlugin } from "@buape/carbon/gateway";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearGateways,
  getGateway,
  registerGateway,
  unregisterGateway,
} from "./gateway-registry.js";

function fakeGateway(props: Partial<GatewayPlugin> = {}): GatewayPlugin {
  return { isConnected: true, ...props } as unknown as GatewayPlugin;
}

describe("gateway-registry", () => {
  beforeEach(() => {
    clearGateways();
  });

  it("stores and retrieves a gateway by account", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway);
    expect(getGateway("account-a")).toBe(gateway);
    expect(getGateway("account-b")).toBeUndefined();
  });

  it("uses collision-safe key when accountId is undefined", () => {
    const gateway = fakeGateway();
    registerGateway(undefined, gateway);
    expect(getGateway(undefined)).toBe(gateway);
    // "default" as a literal account ID must not collide with the sentinel key
    expect(getGateway("default")).toBeUndefined();
  });

  it("unregisters a gateway", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway);
    unregisterGateway("account-a");
    expect(getGateway("account-a")).toBeUndefined();
  });

  it("clears all gateways", () => {
    registerGateway("a", fakeGateway());
    registerGateway("b", fakeGateway());
    clearGateways();
    expect(getGateway("a")).toBeUndefined();
    expect(getGateway("b")).toBeUndefined();
  });

  it("overwrites existing entry for same account", () => {
    const gateway1 = fakeGateway({ isConnected: true });
    const gateway2 = fakeGateway({ isConnected: false });
    registerGateway("account-a", gateway1);
    registerGateway("account-a", gateway2);
    expect(getGateway("account-a")).toBe(gateway2);
  });
});
