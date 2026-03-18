import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
  detectBundleManifestFormat,
  loadBundleManifest,
} from "./bundle-manifest.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-bundle-manifest", tempDirs);
}

const mkdirSafe = mkdirSafeDir;

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("bundle manifest parsing", () => {
  it("detects and loads Codex bundle manifests", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, ".codex-plugin"));
    mkdirSafe(path.join(rootDir, "skills"));
    mkdirSafe(path.join(rootDir, "hooks"));
    fs.writeFileSync(
      path.join(rootDir, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH),
      JSON.stringify({
        name: "Sample Bundle",
        description: "Codex fixture",
        skills: "skills",
        hooks: "hooks",
        mcpServers: {
          sample: {
            command: "node",
            args: ["server.js"],
          },
        },
        apps: {
          sample: {
            title: "Sample App",
          },
        },
      }),
      "utf-8",
    );

    expect(detectBundleManifestFormat(rootDir)).toBe("codex");
    const result = loadBundleManifest({ rootDir, bundleFormat: "codex" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest).toMatchObject({
      id: "sample-bundle",
      name: "Sample Bundle",
      description: "Codex fixture",
      bundleFormat: "codex",
      skills: ["skills"],
      hooks: ["hooks"],
      capabilities: expect.arrayContaining(["hooks", "skills", "mcpServers", "apps"]),
    });
  });

  it("detects and loads Claude bundle manifests from the component layout", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, ".claude-plugin"));
    mkdirSafe(path.join(rootDir, "skill-packs", "starter"));
    mkdirSafe(path.join(rootDir, "commands-pack"));
    mkdirSafe(path.join(rootDir, "agents-pack"));
    mkdirSafe(path.join(rootDir, "hooks-pack"));
    mkdirSafe(path.join(rootDir, "mcp"));
    mkdirSafe(path.join(rootDir, "lsp"));
    mkdirSafe(path.join(rootDir, "styles"));
    mkdirSafe(path.join(rootDir, "hooks"));
    fs.writeFileSync(path.join(rootDir, "hooks", "hooks.json"), '{"hooks":[]}', "utf-8");
    fs.writeFileSync(path.join(rootDir, "settings.json"), '{"hideThinkingBlock":true}', "utf-8");
    fs.writeFileSync(
      path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH),
      JSON.stringify({
        name: "Claude Sample",
        description: "Claude fixture",
        skills: ["skill-packs/starter"],
        commands: "commands-pack",
        agents: "agents-pack",
        hooks: "hooks-pack",
        mcpServers: "mcp",
        lspServers: "lsp",
        outputStyles: "styles",
      }),
      "utf-8",
    );

    expect(detectBundleManifestFormat(rootDir)).toBe("claude");
    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest).toMatchObject({
      id: "claude-sample",
      name: "Claude Sample",
      description: "Claude fixture",
      bundleFormat: "claude",
      skills: ["skill-packs/starter", "commands-pack", "agents-pack", "styles"],
      settingsFiles: ["settings.json"],
      hooks: ["hooks/hooks.json", "hooks-pack"],
      capabilities: expect.arrayContaining([
        "hooks",
        "skills",
        "commands",
        "agents",
        "mcpServers",
        "lspServers",
        "outputStyles",
        "settings",
      ]),
    });
  });

  it("detects and loads Cursor bundle manifests", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, ".cursor-plugin"));
    mkdirSafe(path.join(rootDir, "skills"));
    mkdirSafe(path.join(rootDir, ".cursor", "commands"));
    mkdirSafe(path.join(rootDir, ".cursor", "rules"));
    mkdirSafe(path.join(rootDir, ".cursor", "agents"));
    fs.writeFileSync(path.join(rootDir, ".cursor", "hooks.json"), '{"hooks":[]}', "utf-8");
    fs.writeFileSync(
      path.join(rootDir, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH),
      JSON.stringify({
        name: "Cursor Sample",
        description: "Cursor fixture",
        mcpServers: "./.mcp.json",
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(rootDir, ".mcp.json"), '{"servers":{}}', "utf-8");

    expect(detectBundleManifestFormat(rootDir)).toBe("cursor");
    const result = loadBundleManifest({ rootDir, bundleFormat: "cursor" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest).toMatchObject({
      id: "cursor-sample",
      name: "Cursor Sample",
      description: "Cursor fixture",
      bundleFormat: "cursor",
      skills: ["skills", ".cursor/commands"],
      hooks: [],
      capabilities: expect.arrayContaining([
        "skills",
        "commands",
        "agents",
        "rules",
        "hooks",
        "mcpServers",
      ]),
    });
  });

  it("detects manifestless Claude bundles from the default layout", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, "commands"));
    mkdirSafe(path.join(rootDir, "skills"));
    fs.writeFileSync(path.join(rootDir, "settings.json"), '{"hideThinkingBlock":true}', "utf-8");

    expect(detectBundleManifestFormat(rootDir)).toBe("claude");
    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.manifest.id).toBe(path.basename(rootDir).toLowerCase());
    expect(result.manifest.skills).toEqual(["skills", "commands"]);
    expect(result.manifest.settingsFiles).toEqual(["settings.json"]);
    expect(result.manifest.capabilities).toEqual(
      expect.arrayContaining(["skills", "commands", "settings"]),
    );
  });

  it("resolves Claude bundle hooks from default and declared paths", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, ".claude-plugin"));
    mkdirSafe(path.join(rootDir, "hooks"));
    fs.writeFileSync(path.join(rootDir, "hooks", "hooks.json"), '{"hooks":[]}', "utf-8");
    fs.writeFileSync(
      path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH),
      JSON.stringify({
        name: "Hook Plugin",
        description: "Claude hooks fixture",
      }),
      "utf-8",
    );

    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.hooks).toEqual(["hooks/hooks.json"]);
    expect(result.manifest.capabilities).toContain("hooks");
  });

  it("resolves Claude bundle hooks from manifest-declared paths only", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, ".claude-plugin"));
    mkdirSafe(path.join(rootDir, "custom-hooks"));
    fs.writeFileSync(
      path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH),
      JSON.stringify({
        name: "Custom Hook Plugin",
        hooks: "custom-hooks",
      }),
      "utf-8",
    );

    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.hooks).toEqual(["custom-hooks"]);
    expect(result.manifest.capabilities).toContain("hooks");
  });

  it("returns empty hooks for Claude bundles with no hooks directory", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, ".claude-plugin"));
    mkdirSafe(path.join(rootDir, "skills"));
    fs.writeFileSync(
      path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH),
      JSON.stringify({ name: "No Hooks" }),
      "utf-8",
    );

    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.hooks).toEqual([]);
    expect(result.manifest.capabilities).not.toContain("hooks");
  });

  it("does not misclassify native index plugins as manifestless Claude bundles", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, "commands"));
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {}", "utf-8");

    expect(detectBundleManifestFormat(rootDir)).toBeNull();
  });
});
