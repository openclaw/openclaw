import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

describe("Claude bundle plugin inspect integration", () => {
  let rootDir: string;
  const tempDirs: string[] = [];

  function writeFixtureEntries(
    entries: Readonly<Record<string, string | Record<string, unknown>>>,
  ) {
    Object.entries(entries).forEach(([relativePath, value]) => {
      const file = path.join(rootDir, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf-8");
    });
  }

  beforeAll(() => {
    rootDir = makeTrackedTempDir("openclaw-claude-bundle", tempDirs);
    for (const relativeDir of ["custom-hooks", "agents", "output-styles"]) {
      fs.mkdirSync(path.join(rootDir, relativeDir), { recursive: true });
    }

    writeFixtureEntries({
      ".claude-plugin/plugin.json": {
        name: "Test Claude Plugin",
        description: "Integration test fixture for Claude bundle inspection",
        version: "1.0.0",
        skills: ["skill-packs"],
        commands: "extra-commands",
        agents: "agents",
        hooks: "custom-hooks",
        mcpServers: ".mcp.json",
        lspServers: ".lsp.json",
        outputStyles: "output-styles",
      },
      "skill-packs/demo/SKILL.md": "---\nname: demo\ndescription: Demo\n---\nDemo.",
      "extra-commands/cmd/SKILL.md": "---\nname: cmd\ndescription: Command\n---\nRun.",
      "hooks/hooks.json": '{"hooks":[]}',
      ".mcp.json": {
        mcpServers: {
          "test-stdio-server": { command: "echo", args: ["hello"] },
          "test-sse-server": { type: "sse", url: "http://localhost:3000/sse" },
        },
      },
      "settings.json": { thinkingLevel: "high" },
      ".lsp.json": {
        lspServers: {
          "typescript-lsp": { command: "typescript-language-server", args: ["--stdio"] },
        },
      },
    });
  });

  afterAll(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it("loads the full Claude bundle manifest with all capabilities", () => {
    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected Claude bundle manifest to load");
    }
    expect(result.manifest).toEqual({
      id: "test-claude-plugin",
      name: "Test Claude Plugin",
      description: "Integration test fixture for Claude bundle inspection",
      version: "1.0.0",
      skills: ["skill-packs", "extra-commands", "agents", "output-styles"],
      settingsFiles: ["settings.json"],
      hooks: ["hooks/hooks.json", "custom-hooks"],
      bundleFormat: "claude",
      capabilities: [
        "skills",
        "commands",
        "agents",
        "hooks",
        "mcpServers",
        "lspServers",
        "outputStyles",
        "settings",
      ],
    });
  });

  it("inspects MCP runtime support across stdio and HTTP transports", () => {
    const params = { pluginId: "test-claude-plugin", rootDir, bundleFormat: "claude" as const };
    expect(inspectBundleMcpRuntimeSupport(params)).toMatchObject({
      stdioServerNames: ["test-stdio-server"],
      supportedServerNames: ["test-stdio-server", "test-sse-server"],
      unsupportedServerNames: [],
      diagnostics: [],
    });
  });

  it("inspects LSP runtime support with stdio server", () => {
    const params = { pluginId: "test-claude-plugin", rootDir, bundleFormat: "claude" as const };
    expect(inspectBundleLspRuntimeSupport(params)).toMatchObject({
      supportedServerNames: ["typescript-lsp"],
      unsupportedServerNames: [],
      diagnostics: [],
    });
  });
});
