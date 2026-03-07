import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveWebListener,
  requireActiveWebListener,
  setActiveWebListener,
  type ActiveWebListener,
} from "./active-listener.js";

function stubListener(overrides?: Partial<ActiveWebListener>): ActiveWebListener {
  return {
    sendMessage: async () => ({ messageId: "m1" }),
    sendPoll: async () => ({ messageId: "p1" }),
    sendReaction: async () => {},
    sendComposingTo: async () => {},
    ...overrides,
  };
}

describe("active-listener", () => {
  afterEach(() => {
    setActiveWebListener(null);
    setActiveWebListener("work", null);
    setActiveWebListener("custom", null);
  });

  it("registers and retrieves the default listener", () => {
    const listener = stubListener();
    setActiveWebListener(listener);
    expect(getActiveWebListener()).toBe(listener);
    expect(requireActiveWebListener().listener).toBe(listener);
    expect(requireActiveWebListener().accountId).toBe("default");
  });

  it("registers and retrieves a named listener", () => {
    const listener = stubListener();
    setActiveWebListener("work", listener);
    expect(getActiveWebListener("work")).toBe(listener);
    expect(requireActiveWebListener("work").listener).toBe(listener);
    expect(requireActiveWebListener("work").accountId).toBe("work");
  });

  it("throws when no listener is registered", () => {
    expect(() => requireActiveWebListener()).toThrow(/No active WhatsApp Web listener/);
  });

  it("throws when the requested account has no listener", () => {
    setActiveWebListener(stubListener());
    expect(() => requireActiveWebListener("work")).toThrow(/No active WhatsApp Web listener/);
  });

  it("falls back to sole listener when no explicit account is given", () => {
    // Simulate a config where the single account is named "custom" (not "default").
    const listener = stubListener();
    setActiveWebListener("custom", listener);

    // No explicit accountId -> would normally look up "default" and fail.
    // With the fallback, it should find the sole registered listener.
    const result = requireActiveWebListener();
    expect(result.listener).toBe(listener);
    expect(result.accountId).toBe("custom");
  });

  it("falls back to sole listener when accountId is empty string", () => {
    const listener = stubListener();
    setActiveWebListener("custom", listener);

    const result = requireActiveWebListener("");
    expect(result.listener).toBe(listener);
    expect(result.accountId).toBe("custom");
  });

  it("does not fall back when an explicit account is requested", () => {
    const listener = stubListener();
    setActiveWebListener("custom", listener);

    // Explicit "work" requested -> should NOT fall back to "custom"
    expect(() => requireActiveWebListener("work")).toThrow(/No active WhatsApp Web listener/);
  });

  it("does not fall back when multiple listeners are registered", () => {
    setActiveWebListener("custom", stubListener());
    setActiveWebListener("work", stubListener());

    // Two listeners registered, no default -> should not guess
    expect(() => requireActiveWebListener()).toThrow(/No active WhatsApp Web listener/);
  });

  it("clears the listener on null", () => {
    setActiveWebListener(stubListener());
    setActiveWebListener(null);
    expect(getActiveWebListener()).toBeNull();
  });

  it("clears a named listener on null", () => {
    setActiveWebListener("work", stubListener());
    setActiveWebListener("work", null);
    expect(getActiveWebListener("work")).toBeNull();
  });
});
