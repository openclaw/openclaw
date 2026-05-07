import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "../../../plugins/registry.js";
import { listPluginNodeCapabilities } from "./route-capability.js";

describe("plugin node capability route metadata", () => {
  it("lists one capability per surface with the shortest ttl", () => {
    const registry = {
      httpRoutes: [
        { pluginId: "one", path: "/one", nodeCapability: { surface: "canvas" } },
        { pluginId: "two", path: "/two", nodeCapability: { surface: "canvas", ttlMs: 100 } },
        { pluginId: "files", path: "/files", nodeCapability: { surface: "files", ttlMs: 200 } },
      ],
    } as unknown as PluginRegistry;

    expect(listPluginNodeCapabilities(registry)).toEqual([
      { surface: "canvas", ttlMs: 100 },
      { surface: "files", ttlMs: 200 },
    ]);
  });
});
