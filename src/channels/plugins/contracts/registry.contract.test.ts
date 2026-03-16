import { describe, expect, it } from "vitest";
import {
  actionContractRegistry,
  pluginContractRegistry,
  setupContractRegistry,
  statusContractRegistry,
  surfaceContractRegistry,
  type ChannelPluginSurface,
} from "./registry.js";

const orderedSurfaceKeys = [
  "actions",
  "setup",
  "status",
  "outbound",
  "messaging",
  "threading",
  "directory",
  "gateway",
] as const satisfies readonly ChannelPluginSurface[];

describe("channel contract registry", () => {
  it("does not duplicate channel plugin ids", () => {
    const ids = pluginContractRegistry.map((entry) => entry.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("keeps the surface registry aligned with the plugin registry", () => {
    expect(surfaceContractRegistry.map((entry) => entry.id).toSorted()).toEqual(
      pluginContractRegistry.map((entry) => entry.id).toSorted(),
    );
  });

  it("declares the actual owned channel plugin surfaces explicitly", () => {
    for (const entry of surfaceContractRegistry) {
      const actual = orderedSurfaceKeys.filter((surface) => Boolean(entry.plugin[surface]));
      expect([...entry.surfaces].toSorted()).toEqual(actual.toSorted());
    }
  });

  it("only installs deep action coverage for plugins that declare actions", () => {
    const actionSurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("actions"))
        .map((entry) => entry.id),
    );
    for (const entry of actionContractRegistry) {
      expect(actionSurfaceIds.has(entry.id)).toBe(true);
    }
  });

  it("only installs deep setup coverage for plugins that declare setup", () => {
    const setupSurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("setup"))
        .map((entry) => entry.id),
    );
    for (const entry of setupContractRegistry) {
      expect(setupSurfaceIds.has(entry.id)).toBe(true);
    }
  });

  it("only installs deep status coverage for plugins that declare status", () => {
    const statusSurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("status"))
        .map((entry) => entry.id),
    );
    for (const entry of statusContractRegistry) {
      expect(statusSurfaceIds.has(entry.id)).toBe(true);
    }
  });
});
