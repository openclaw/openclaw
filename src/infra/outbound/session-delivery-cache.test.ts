import { beforeEach, describe, expect, it } from "vitest";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  clearCachedDeliveryContext,
  getCachedDeliveryContext,
  resetDeliveryCacheForTest,
  setCachedDeliveryContext,
} from "./session-delivery-cache.js";

describe("session-delivery-cache", () => {
  beforeEach(() => {
    resetDeliveryCacheForTest();
  });

  it("returns undefined when nothing has been cached for a session", () => {
    expect(getCachedDeliveryContext("agent:main:main")).toBeUndefined();
  });

  it("stores and retrieves a delivery context by session key", () => {
    const ctx: DeliveryContext = {
      channel: "discord",
      to: "channel:42",
    };
    setCachedDeliveryContext("agent:main:main", ctx);
    expect(getCachedDeliveryContext("agent:main:main")).toBe(ctx);
  });

  it("keeps cached contexts isolated per session key", () => {
    const a: DeliveryContext = { channel: "discord", to: "a" };
    const b: DeliveryContext = { channel: "slack", to: "b" };
    setCachedDeliveryContext("agent:a:main", a);
    setCachedDeliveryContext("agent:b:main", b);
    expect(getCachedDeliveryContext("agent:a:main")).toBe(a);
    expect(getCachedDeliveryContext("agent:b:main")).toBe(b);
  });

  it("clears only the targeted session key", () => {
    setCachedDeliveryContext("agent:a:main", { channel: "discord", to: "a" });
    setCachedDeliveryContext("agent:b:main", { channel: "slack", to: "b" });
    clearCachedDeliveryContext("agent:a:main");
    expect(getCachedDeliveryContext("agent:a:main")).toBeUndefined();
    expect(getCachedDeliveryContext("agent:b:main")).toBeDefined();
  });

  it("overwrites on repeated sets for the same session key", () => {
    const first: DeliveryContext = { channel: "discord", to: "a" };
    const second: DeliveryContext = { channel: "discord", to: "b" };
    setCachedDeliveryContext("agent:a:main", first);
    setCachedDeliveryContext("agent:a:main", second);
    expect(getCachedDeliveryContext("agent:a:main")).toBe(second);
  });

  it("resetDeliveryCacheForTest clears all cached entries", () => {
    setCachedDeliveryContext("agent:a:main", { channel: "discord", to: "a" });
    setCachedDeliveryContext("agent:b:main", { channel: "slack", to: "b" });
    resetDeliveryCacheForTest();
    expect(getCachedDeliveryContext("agent:a:main")).toBeUndefined();
    expect(getCachedDeliveryContext("agent:b:main")).toBeUndefined();
  });
});
