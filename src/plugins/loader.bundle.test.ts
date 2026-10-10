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

function writeFiles(root: string, files: Record<string, string | object>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSafe(path.dirname(file));
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  }
}

const skill = "---\ndescription: fixture\n---\n";
const bundles: Array<{
  id: string;
  format: string;
  capabilities: string[];
  files: Record<string, string | object>;
}> = [
  {
    id: "sample-bundle",
    format: "codex",
    capabilities: ["skills"],
    files: {
      ".codex-plugin/plugin.json": { name: "Sample Bundle", skills: "skills" },
      "skills/SKILL.md": skill,
    },
  },
  {
    id: "claude-skills",
    format: "claude",
    capabilities: ["skills", "commands", "settings"],
    files: { "commands/review.md": skill, "settings.json": { hideThinkingBlock: true } },
  },
  {
    id: "claude-mcp",
    format: "claude",
    capabilities: ["mcpServers"],
    files: {
      ".claude-plugin/plugin.json": { name: "Claude MCP" },
      ".mcp.json": { mcpServers: { probe: { command: "node", args: ["./probe.mjs"] } } },
    },
  },
  {
    id: "cursor-skills",
    format: "cursor",
    capabilities: ["skills", "commands"],
    files: {
      ".cursor-plugin/plugin.json": { name: "Cursor Skills" },
      ".cursor/commands/review.md": skill,
    },
  },
];

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(bundles)("loads supported $id bundle surfaces without a runtime entry", (fixture) => {
  const registry = loadBundleFixture({
    pluginId: fixture.id,
    build: (root) => writeFiles(root, fixture.files),
  });
  expect(registry.plugins.find((entry) => entry.id === fixture.id)).toMatchObject({
    status: "loaded",
    format: "bundle",
    bundleFormat: fixture.format,
    bundleCapabilities: fixture.capabilities,
  });
  expect(
    registry.diagnostics.some(
      (diag) =>
        diag.pluginId === fixture.id &&
        diag.message.includes("bundle capability detected but not wired"),
    ),
  ).toBe(false);
});

it("accepts bundle HTTP MCP and warns only for incomplete configs", () => {
  const pluginId = "claude-mcp-url";
  const registry = loadBundleFixture({
    pluginId,
    env: { OPENCLAW_HOME: makePluginLoaderTempDir() },
    build: (root) =>
      writeFiles(root, {
        ".claude-plugin/plugin.json": { name: "Claude MCP URL" },
        ".mcp.json": {
          mcpServers: {
            remoteProbe: { transport: "streamable-http", url: "http://127.0.0.1:8787/mcp" },
            incompleteProbe: { transport: "streamable-http" },
          },
        },
      }),
  });
  expect(registry.plugins.find((entry) => entry.id === pluginId)).toMatchObject({
    status: "loaded",
    bundleCapabilities: ["mcpServers"],
  });
  expect(
    registry.diagnostics.some(
      (diag) =>
        diag.pluginId === pluginId &&
        diag.message.includes("unsupported transports or incomplete configs") &&
        diag.message.includes("incompleteProbe"),
    ),
  ).toBe(true);
  expect(
    registry.diagnostics.some(
      (diag) => diag.pluginId === pluginId && diag.message.includes("remoteProbe"),
    ),
  ).toBe(false);
});
