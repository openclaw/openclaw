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

  beforeAll(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-claude-bundle-"));

    // .claude-plugin/plugin.json
    const manifestDir = path.join(rootDir, ".claude-plugin");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, "plugin.json"),
      JSON.stringify({
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
      }),
      "utf-8",
    );

    // skills/demo/SKILL.md
    const skillDir = path.join(rootDir, "skill-packs", "demo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: A demo skill\n---\nDo something useful.",
      "utf-8",
    );

    // commands/cmd/SKILL.md
    const cmdDir = path.join(rootDir, "extra-commands", "cmd");
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(cmdDir, "SKILL.md"),
      "---\nname: cmd\ndescription: A command skill\n---\nRun a command.",
      "utf-8",
    );

    // hooks/hooks.json (default hook path)
    const hooksDir = path.join(rootDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "hooks.json"), '{"hooks":[]}', "utf-8");

    // custom-hooks/ (manifest-declared hook path)
    fs.mkdirSync(path.join(rootDir, "custom-hooks"), { recursive: true });

    // .mcp.json with a stdio MCP server
    fs.writeFileSync(
      path.join(rootDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "test-stdio-server": {
            command: "echo",
            args: ["hello"],
          },
          "test-sse-server": {
            url: "http://localhost:3000/sse",
          },
        },
      }),
      "utf-8",
    );

    // settings.json
    fs.writeFileSync(
      path.join(rootDir, "settings.json"),
      JSON.stringify({ thinkingLevel: "high" }),
      "utf-8",
    );

    // agents/ directory
    fs.mkdirSync(path.join(rootDir, "agents"), { recursive: true });

    // .lsp.json with a stdio LSP server
    fs.writeFileSync(
      path.join(rootDir, ".lsp.json"),
      JSON.stringify({
        lspServers: {
          "typescript-lsp": {
            command: "typescript-language-server",
            args: ["--stdio"],
          },
        },
      }),
      "utf-8",
    );

    // output-styles/ directory
    fs.mkdirSync(path.join(rootDir, "output-styles"), { recursive: true });
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

    expect(mcp.hasSupportedStdioServer).toBe(true);
    expect(mcp.supportedServerNames).toContain("test-stdio-server");
    expect(mcp.unsupportedServerNames).toContain("test-sse-server");
    expectNoDiagnostics(mcp.diagnostics);
  });

  it("inspects LSP runtime support with stdio server", () => {
    const lsp = inspectBundleLspRuntimeSupport({
      pluginId: "test-claude-plugin",
      rootDir,
      bundleFormat: "claude",
    });

    expect(lsp.hasStdioServer).toBe(true);
    expect(lsp.supportedServerNames).toContain("typescript-lsp");
    expect(lsp.unsupportedServerNames).toEqual([]);
    expectNoDiagnostics(lsp.diagnostics);
  });
});
