import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../extensions/huggingface/openclaw.plugin.json" with { type: "json" };
import { loadMergedBundleMcpConfig } from "../agents/bundle-mcp-config.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import { loadPluginDeclaredMcpServers } from "./bundle-mcp.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const server = {
  transport: "streamable-http",
  url: "https://huggingface.co/mcp",
  auth: "oauth",
} satisfies McpServerConfig;
const provider = createPluginManifestRecordFixture({
  id: manifest.id,
  origin: "bundled",
  format: "openclaw",
  rootDir: path.resolve(import.meta.dirname, "../../extensions/huggingface"),
  enabledByDefault: manifest.enabledByDefault,
  mcpServers: manifest.mcpServers,
});
const legacy = createPluginManifestRecordFixture({
  id: "hugging-face",
  origin: "global",
  format: "openclaw",
  rootDir: path.resolve(import.meta.dirname, "../../extensions"),
  mcpServers: { "hugging-face": server },
});

describe("Hugging Face inference and Hub tools", () => {
  it("keeps Hub tools discoverable without enabling them for inference users", () => {
    expect(loadPluginDeclaredMcpServers(provider)["hugging-face"]).toMatchObject({
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

  it.each([undefined, false, "true", true])("honors explicit Hub enablement: %s", (enabled) => {
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: { plugins: [provider] },
      cfg: { plugins: { entries: { huggingface: { config: { hub: { enabled } } } } } },
    });
    if (enabled === true) {
      expect(loaded.config.mcpServers).toMatchObject({
        "hugging-face": { ...server, enabled: true },
      });
      expect(loaded.config.mcpServers["hugging-face"]).not.toHaveProperty("enabledByConfig");
    } else {
      expect(loaded.config.mcpServers).toEqual({});
    }
  });

  it.each([
    { enabledByConfig: [] },
    { enabledByConfig: ["hub", "missing"] },
    { enabledByConfig: ["hub", ""] },
  ])("does not activate an invalid config path: $enabledByConfig", ({ enabledByConfig }) => {
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: {
        plugins: [{ ...provider, mcpServers: { "hugging-face": { ...server, enabledByConfig } } }],
      },
      cfg: { plugins: { entries: { huggingface: { config: { hub: { enabled: true } } } } } },
    });
    expect(loaded.config.mcpServers).toEqual({});
  });

  it("keeps an operator-level disable authoritative over the plugin toggle", () => {
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: { plugins: [provider] },
      cfg: {
        plugins: { entries: { huggingface: { config: { hub: { enabled: true } } } } },
        mcp: { servers: { "hugging-face": { ...server, enabled: false } } },
      },
    });
    expect(loaded.config.mcpServers).toEqual({});
  });

  it.each([false, true])(
    "preserves an existing enabled Hub wrapper regardless of inventory order: %s",
    (legacyFirst) => {
      const loaded = loadMergedBundleMcpConfig({
        workspaceDir: provider.rootDir,
        manifestRegistry: { plugins: legacyFirst ? [legacy, provider] : [provider, legacy] },
        cfg: { plugins: { entries: { "hugging-face": { enabled: true } } } },
      });
      expect(loaded.config.mcpServers).toEqual({ "hugging-face": server });
      expect(loaded.pluginIdsByServer).toEqual({ "hugging-face": "hugging-face" });
    },
  );

  it("does not reactivate an explicitly disabled legacy Hub wrapper", () => {
    const loaded = loadMergedBundleMcpConfig({
      workspaceDir: provider.rootDir,
      manifestRegistry: { plugins: [legacy, provider] },
      cfg: { plugins: { entries: { "hugging-face": { enabled: false } } } },
    });
    expect(loaded.config.mcpServers).toEqual({});
  });
});
