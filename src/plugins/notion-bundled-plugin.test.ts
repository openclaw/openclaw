import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeConfiguredBundleMcpServers } from "../agents/bundle-mcp-config.js";
import type { OpenClawConfig } from "../config/types.js";
import { loadWorkspaceSkills } from "../skills/loading/workspace-skill-loader.js";
import { withEnv } from "../test-utils/env.js";
import { loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const sourceRoot = fileURLToPath(new URL("../../extensions/notion/", import.meta.url));
let root: string;
let pluginRoot: string;
let workspaceDir: string;
let homeDir: string;

beforeAll(async () => {
  const scratchDir = fileURLToPath(new URL("../../.openclaw/tmp/", import.meta.url));
  await fs.mkdir(scratchDir, { recursive: true });
  root = await fs.mkdtemp(path.join(scratchDir, "notion-boundary-"));
  pluginRoot = path.join(root, "bundled", "notion");
  workspaceDir = path.join(root, "workspace");
  homeDir = path.join(root, "home");
  await Promise.all([
    fs.cp(sourceRoot, pluginRoot, { recursive: true }),
    fs.mkdir(workspaceDir, { recursive: true }),
    fs.mkdir(homeDir, { recursive: true }),
  ]);
});

afterAll(async () => {
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function inspectPlugin(enabled?: boolean) {
  const config: OpenClawConfig = {
    plugins: {
      entries: enabled === undefined ? {} : { notion: { enabled } },
    },
  };
  return withEnv(
    {
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: path.join(homeDir, ".openclaw"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
    },
    () => {
      const manifestRegistry = loadPluginManifestRegistryCore({
        config,
        workspaceDir,
        env: process.env,
      });
      const snapshot = createPluginMetadataSnapshotFixture(manifestRegistry);
      const policyHash = resolveInstalledPluginIndexPolicyHash(config);
      const pluginMetadataSnapshot = {
        ...snapshot,
        policyHash,
        workspaceDir,
        index: { ...snapshot.index, policyHash },
        registryIndex: { ...snapshot.registryIndex, policyHash },
      };
      return {
        config,
        manifestRegistry,
        mcp: loadEnabledBundleMcpConfig({ workspaceDir, cfg: config, manifestRegistry }),
        skills: loadWorkspaceSkills(workspaceDir, {
          config,
          pluginMetadataSnapshot,
          managedSkillsDir: path.join(root, "managed"),
          bundledSkillsDir: path.join(root, "skills"),
          pluginSkillsDir: path.join(root, "learned"),
        }),
      };
    },
  );
}

describe("bundled Notion integration", () => {
  it("discovers the actual manifest and loads its OAuth server and workflow skill", async () => {
    const result = inspectPlugin(true);
    expect(result.manifestRegistry.plugins).toEqual([
      expect.objectContaining({ id: "notion", rootDir: pluginRoot, origin: "bundled" }),
    ]);
    expect(result.mcp.diagnostics).toEqual([]);
    expect(result.mcp.config.mcpServers).toEqual({
      notion: {
        transport: "streamable-http",
        url: "https://mcp.notion.com/mcp",
        auth: "oauth",
      },
    });
    expect(result.mcp.pluginIdsByServer).toEqual({ notion: "notion" });
    expect(result.skills.map((entry) => entry.skill.name)).toEqual(["notion-shared-brain"]);
    const publishedSkillPath = path.join(root, "learned", "notion-shared-brain", "SKILL.md");
    expect(result.skills[0]?.skill.filePath).toBe(publishedSkillPath);
    expect(await fs.realpath(publishedSkillPath)).toBe(
      path.join(pluginRoot, "skills", "notion-shared-brain", "SKILL.md"),
    );
  });

  it.each([undefined, false])("contributes nothing when enabled=%s", (enabled) => {
    const result = inspectPlugin(enabled);
    expect(result.mcp.config.mcpServers).toEqual({});
    expect(result.mcp.pluginIdsByServer).toEqual({});
    expect(result.skills).toEqual([]);
  });

  it("preserves operator replacement and disable precedence without duplicate servers", () => {
    const result = inspectPlugin(true);
    const operatorServer = {
      transport: "streamable-http" as const,
      url: "https://notion.example.test/mcp",
      auth: "oauth" as const,
    };
    const replacement = mergeConfiguredBundleMcpServers(result.mcp, {
      cfg: { ...result.config, mcp: { servers: { notion: operatorServer } } },
    });
    expect(replacement.config.mcpServers).toEqual({ notion: operatorServer });
    expect(replacement.pluginIdsByServer).toEqual({});
    const disabled = mergeConfiguredBundleMcpServers(result.mcp, {
      cfg: { ...result.config, mcp: { servers: { notion: { enabled: false } } } },
    });
    expect(disabled.config.mcpServers).toEqual({});
    expect(disabled.pluginIdsByServer).toEqual({});
  });
});
