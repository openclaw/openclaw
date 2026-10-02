import { describe, expect, it, vi } from "vitest";
import { encodePluginDiscoveryId } from "../../plugins/catalog-discovery.js";
import { pluginsHandlers } from "./plugins.js";
import type { GatewayRequestContext } from "./types.js";
const readers = vi.hoisted(() => ({ installed: vi.fn(), catalog: vi.fn() }));
vi.mock("../../plugins/management-skill-read.js", () => ({
  readManagedPluginSkill: readers.installed,
}));
vi.mock("../../infra/clawhub-plugin-skills.js", () => ({
  fetchClawHubPluginSkill: readers.catalog,
}));

async function read(params: Record<string, unknown>) {
  const respond = vi.fn();
  await pluginsHandlers["plugins.skills.read"]!({
    req: { type: "req", id: "skill-read", method: "plugins.skills.read", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
  });
  return respond;
}

describe("plugin skill read Gateway boundary", () => {
  it.each(["installed", "catalog"])(
    "routes %s reads through the declared owner and returns the full bundle",
    async (source) => {
      const bundle = {
        name: "guide",
        rootPath: "skills/guide",
        entryPath: "SKILL.md",
        files: [{ path: "SKILL.md", status: "ready", content: "Full instructions", sizeBytes: 17 }],
        directories: [],
        inventoryComplete: true,
      };
      readers.installed.mockResolvedValue(bundle);
      readers.catalog.mockResolvedValue(bundle);
      const result = await read(
        source === "installed"
          ? { source, pluginId: "example", skillName: "guide" }
          : {
              source,
              catalogId: encodePluginDiscoveryId("@example/plugin"),
              version: "1.0.0",
              skillName: "guide",
            },
      );
      expect(result).toHaveBeenCalledWith(true, bundle, undefined);
      if (source === "catalog") {
        expect(readers.catalog).toHaveBeenLastCalledWith({
          packageName: "@example/plugin",
          version: "1.0.0",
          skillName: "guide",
        });
      }
    },
  );
  it.each([
    { source: "catalog", catalogId: "invalid", version: "1.0.0", skillName: "guide" },
    {
      source: "catalog",
      catalogId: encodePluginDiscoveryId("@example/plugin"),
      skillName: "guide",
    },
    { source: "installed", pluginId: "example", skillName: "guide", path: "/private" },
  ])("rejects invalid source/path requests", async (params) => {
    const result = await read(params);
    expect(result).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
