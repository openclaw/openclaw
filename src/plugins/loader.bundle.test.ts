import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadBundleFixture,
  makePluginLoaderTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
} from "./loader.test-fixtures.js";

function loadBundle(
  pluginId: string,
  files: Record<string, string | object>,
  env?: NodeJS.ProcessEnv,
) {
  const registry = loadBundleFixture({
    pluginId,
    env,
    build(root) {
      for (const [name, content] of Object.entries(files)) {
        const file = path.join(root, name);
        mkdirSafe(path.dirname(file));
        fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
      }
    },
  });
  return {
    plugin: registry.plugins.find(({ id }) => id === pluginId),
    warns: (...parts: string[]) =>
      registry.diagnostics.some(
        ({ pluginId: id, message }) =>
          id === pluginId && parts.every((part) => message.includes(part)),
      ),
  };
}

const skill = "---\ndescription: fixture\n---\n";
const bundleFiles = {
  "sample-bundle": {
    ".codex-plugin/plugin.json": { name: "Sample Bundle", skills: "skills" },
    "skills/SKILL.md": skill,
  },
  "claude-skills": { "commands/review.md": skill, "settings.json": { hideThinkingBlock: true } },
  "claude-mcp": {
    ".claude-plugin/plugin.json": { name: "Claude MCP" },
    ".mcp.json": { mcpServers: { probe: { command: "node", args: ["./probe.mjs"] } } },
  },
  "cursor-skills": {
    ".cursor-plugin/plugin.json": { name: "Cursor Skills" },
    ".cursor/commands/review.md": skill,
  },
  "claude-mcp-url": {
    ".claude-plugin/plugin.json": { name: "Claude MCP URL" },
    ".mcp.json": {
      mcpServers: {
        remoteProbe: { transport: "streamable-http", url: "http://127.0.0.1:8787/mcp" },
        incompleteProbe: { transport: "streamable-http" },
      },
    },
  },
} satisfies Record<string, Record<string, string | object>>;

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  ["sample-bundle", "codex", ["skills"]],
  ["claude-skills", "claude", ["skills", "commands", "settings"]],
  ["claude-mcp", "claude", ["mcpServers"]],
  ["cursor-skills", "cursor", ["skills", "commands"]],
  ["claude-mcp-url", "claude", ["mcpServers"]],
] as const)(
  "loads supported %s bundle surfaces without a runtime entry",
  (id, format, capabilities) => {
    const { plugin, warns } = loadBundle(
      id,
      bundleFiles[id],
      id === "claude-mcp-url" ? { OPENCLAW_HOME: makePluginLoaderTempDir() } : undefined,
    );
    expect(plugin).toMatchObject({
      status: "loaded",
      format: "bundle",
      bundleFormat: format,
      bundleCapabilities: capabilities,
    });
    expect(warns("bundle capability detected but not wired")).toBe(false);
    if (id === "claude-mcp-url") {
      expect(warns("unsupported transports or incomplete configs", "incompleteProbe")).toBe(true);
      expect(warns("remoteProbe")).toBe(false);
    }
  },
);
