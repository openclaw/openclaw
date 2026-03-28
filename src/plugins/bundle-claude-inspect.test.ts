import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";

/**
 * Integration test: builds a Claude Code bundle plugin fixture on disk
 * and verifies manifest parsing, capability detection, hook resolution,
 * MCP server discovery, and settings detection all work end-to-end.
 */
describe("Claude bundle plugin inspect integration", () => {
  let rootDir: string;

  function writeFixtureText(relativePath: string, value: string) {
    fs.mkdirSync(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(rootDir, relativePath), value, "utf-8");
  }

  function writeFixtureJson(relativePath: string, value: unknown) {
    writeFixtureText(relativePath, JSON.stringify(value));
  }

  function setupClaudeInspectFixture() {
    for (const relativeDir of [
      ".claude-plugin",
      "skill-packs/demo",
      "extra-commands/cmd",
      "hooks",
      "custom-hooks",
      "agents",
      "output-styles",
    ]) {
      fs.mkdirSync(path.join(rootDir, relativeDir), { recursive: true });
    }

    writeFixtureJson(".claude-plugin/plugin.json", {
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
    });
    writeFixtureText(
      "skill-packs/demo/SKILL.md",
      "---\nname: demo\ndescription: A demo skill\n---\nDo something useful.",
    );
    writeFixtureText(
      "extra-commands/cmd/SKILL.md",
      "---\nname: cmd\ndescription: A command skill\n---\nRun a command.",
    );
    writeFixtureText("hooks/hooks.json", '{"hooks":[]}');
    writeFixtureJson(".mcp.json", {
      mcpServers: {
        "test-stdio-server": {
          command: "echo",
          args: ["hello"],
        },
        "test-sse-server": {
          url: "http://localhost:3000/sse",
        },
      },
    });
    writeFixtureJson("settings.json", { thinkingLevel: "high" });
    writeFixtureJson(".lsp.json", {
      lspServers: {
        "typescript-lsp": {
          command: "typescript-language-server",
          args: ["--stdio"],
        },
      },
    });
  }

  function expectLoadedClaudeManifest() {
    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected Claude bundle manifest to load");
    }
    return result.manifest;
  }

  function expectClaudeManifestField(params: {
    field: "skills" | "hooks" | "settingsFiles" | "capabilities";
    includes: readonly string[];
  }) {
    const manifest = expectLoadedClaudeManifest();
    const values = manifest[params.field];
    expect(values).toEqual(expect.arrayContaining([...params.includes]));
  }

  function expectNoDiagnostics(diagnostics: unknown[]) {
    expect(diagnostics).toEqual([]);
  }

  function expectBundleRuntimeSupport(params: {
    actual: {
      supportedServerNames: string[];
      unsupportedServerNames: string[];
      diagnostics: unknown[];
    } & Record<string, unknown>;
    supportedServerNames: readonly string[];
    unsupportedServerNames: readonly string[];
    hasSupportedKey: "hasSupportedStdioServer" | "hasStdioServer";
  }) {
    expect(params.actual[params.hasSupportedKey]).toBe(true);
    expect(params.actual.supportedServerNames).toEqual(
      expect.arrayContaining([...params.supportedServerNames]),
    );
    expect(params.actual.unsupportedServerNames).toEqual([...params.unsupportedServerNames]);
    expectNoDiagnostics(params.actual.diagnostics);
  }

  beforeAll(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-claude-bundle-"));
    setupClaudeInspectFixture();
  });

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("loads the full Claude bundle manifest with all capabilities", () => {
    const m = expectLoadedClaudeManifest();
    expect(m.name).toBe("Test Claude Plugin");
    expect(m.description).toBe("Integration test fixture for Claude bundle inspection");
    expect(m.version).toBe("1.0.0");
    expect(m.bundleFormat).toBe("claude");
  });

  it.each([
    {
      name: "resolves skills from skills, commands, and agents paths",
      field: "skills" as const,
      includes: ["skill-packs", "extra-commands", "agents", "output-styles"],
    },
    {
      name: "resolves hooks from default and declared paths",
      field: "hooks" as const,
      includes: ["hooks/hooks.json", "custom-hooks"],
    },
    {
      name: "detects settings files",
      field: "settingsFiles" as const,
      includes: ["settings.json"],
    },
    {
      name: "detects all bundle capabilities",
      field: "capabilities" as const,
      includes: [
        "skills",
        "commands",
        "agents",
        "hooks",
        "mcpServers",
        "lspServers",
        "outputStyles",
        "settings",
      ],
    },
  ] as const)("$name", ({ field, includes }) => {
    expectClaudeManifestField({ field, includes });
  });

  it("inspects MCP runtime support with supported and unsupported servers", () => {
    const mcp = inspectBundleMcpRuntimeSupport({
      pluginId: "test-claude-plugin",
      rootDir,
      bundleFormat: "claude",
    });

    expectBundleRuntimeSupport({
      actual: mcp,
      supportedServerNames: ["test-stdio-server"],
      unsupportedServerNames: ["test-sse-server"],
      hasSupportedKey: "hasSupportedStdioServer",
    });
  });

  it("inspects LSP runtime support with stdio server", () => {
    const lsp = inspectBundleLspRuntimeSupport({
      pluginId: "test-claude-plugin",
      rootDir,
      bundleFormat: "claude",
    });

    expectBundleRuntimeSupport({
      actual: lsp,
      supportedServerNames: ["typescript-lsp"],
      unsupportedServerNames: [],
      hasSupportedKey: "hasStdioServer",
    });
  });
});
