import { describe, expect, it, beforeEach } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  setActivePluginRegistry,
  getActivePluginRegistry,
  requireActivePluginRegistry,
} from "./runtime.js";

describe("setActivePluginRegistry", () => {
  beforeEach(() => {
    // Clear routes on the current active registry before swapping so the
    // route-preservation logic in setActivePluginRegistry does not carry
    // leftover routes from a previous test into the new clean registry.
    const current = getActivePluginRegistry();
    if (current) {
      current.httpRoutes = [];
    }
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("activates the provided registry", () => {
    const reg = createEmptyPluginRegistry();
    setActivePluginRegistry(reg);
    expect(getActivePluginRegistry()).toBe(reg);
  });

  it("copies httpRoutes from the previous registry to the new one", () => {
    const prev = createEmptyPluginRegistry();
    const route = { path: "/webhook", handler: async () => {}, pluginId: "test" };
    prev.httpRoutes.push(route);
    setActivePluginRegistry(prev);

    const next = createEmptyPluginRegistry();
    setActivePluginRegistry(next);

    expect(next.httpRoutes).toHaveLength(1);
    expect(next.httpRoutes[0].path).toBe("/webhook");
  });

  it("does not duplicate routes that already exist in the new registry", () => {
    const prev = createEmptyPluginRegistry();
    const route = { path: "/hook", handler: async () => {}, pluginId: "a" };
    prev.httpRoutes.push(route);
    setActivePluginRegistry(prev);

    const next = createEmptyPluginRegistry();
    next.httpRoutes.push({ path: "/hook", handler: async () => {}, pluginId: "b" });
    setActivePluginRegistry(next);

    expect(next.httpRoutes).toHaveLength(1);
    expect(next.httpRoutes[0].pluginId).toBe("b");
  });

  it("does not share array references between old and new registries", () => {
    const prev = createEmptyPluginRegistry();
    prev.httpRoutes.push({ path: "/x", handler: async () => {}, pluginId: "p" });
    setActivePluginRegistry(prev);

    const next = createEmptyPluginRegistry();
    setActivePluginRegistry(next);

    // Mutating prev's array should not affect next
    prev.httpRoutes.splice(0, prev.httpRoutes.length);
    expect(next.httpRoutes).toHaveLength(1);
  });
});

describe("requireActivePluginRegistry", () => {
  it("returns the active registry", () => {
    const reg = createEmptyPluginRegistry();
    setActivePluginRegistry(reg);
    expect(requireActivePluginRegistry()).toBe(reg);
  });
});
