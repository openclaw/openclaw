import { describe, expect, it } from "vitest";
import { loadMergedBundleMcpConfig } from "../agents/bundle-mcp-config.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import { loadPluginDeclaredMcpServers } from "./bundle-mcp.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const server = {
  transport: "streamable-http",
  url: "https://example.test/mcp",
  auth: "oauth",
} satisfies McpServerConfig;
const provider = createPluginManifestRecordFixture({
  id: "optional",
  enabledByDefault: true,
  rootDir: import.meta.dirname,
  mcpServers: { shared: { ...server, enabled: false, enabledByConfig: ["tools", "enabled"] } },
});
const legacy = createPluginManifestRecordFixture({
  id: "legacy",
  origin: "global",
  rootDir: import.meta.dirname,
  mcpServers: { shared: server },
});

describe("optional native MCP declarations", () => {
  it("keeps tools discoverable without enabling them for existing users", () => {
    expect(loadPluginDeclaredMcpServers(provider).shared).toMatchObject({
      ...server,
      enabled: false,
    });
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: { plugins: [provider] },
    });
    expect(loaded.config.mcpServers).toEqual({});
    expect(loaded.pluginIdsByServer).toEqual({});
  });

  it.each([undefined, false, "true", true])("honors explicit server enablement: %s", (enabled) => {
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: { plugins: [provider] },
      cfg: { plugins: { entries: { optional: { config: { tools: { enabled } } } } } },
    });
    if (enabled === true) {
      expect(loaded.config.mcpServers).toMatchObject({
        shared: { ...server, enabled: true },
      });
      expect(loaded.config.mcpServers.shared).not.toHaveProperty("enabledByConfig");
    } else {
      expect(loaded.config.mcpServers).toEqual({});
    }
  });

  it.each([
    { enabledByConfig: [] },
    { enabledByConfig: ["tools", "missing"] },
    { enabledByConfig: ["tools", ""] },
  ])("does not activate an invalid config path: $enabledByConfig", ({ enabledByConfig }) => {
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: {
        plugins: [{ ...provider, mcpServers: { shared: { ...server, enabledByConfig } } }],
      },
      cfg: { plugins: { entries: { optional: { config: { tools: { enabled: true } } } } } },
    });
    expect(loaded.config.mcpServers).toEqual({});
  });

  it("keeps an operator-level disable authoritative over the plugin toggle", () => {
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: { plugins: [provider] },
      cfg: {
        plugins: { entries: { optional: { config: { tools: { enabled: true } } } } },
        mcp: { servers: { shared: { ...server, enabled: false } } },
      },
    });
    expect(loaded.config.mcpServers).toEqual({});
  });

  it.each([false, true])(
    "preserves an existing enabled server plugin regardless of inventory order: %s",
    (legacyFirst) => {
      const loaded = loadMergedBundleMcpConfig({
        workspaceDir: provider.rootDir,
        manifestRegistry: { plugins: legacyFirst ? [legacy, provider] : [provider, legacy] },
        cfg: { plugins: { entries: { legacy: { enabled: true } } } },
      });
      expect(loaded.config.mcpServers).toEqual({ shared: server });
      expect(loaded.pluginIdsByServer).toEqual({ shared: "legacy" });
    },
  );

  it("does not reactivate an explicitly disabled legacy server plugin", () => {
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: { plugins: [legacy, provider] },
      cfg: { plugins: { entries: { legacy: { enabled: false } } } },
    });
    expect(loaded.config.mcpServers).toEqual({});
  });
});
