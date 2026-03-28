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

function expectLoadedManifest(rootDir: string, bundleFormat: "codex" | "claude" | "cursor") {
  const result = loadBundleManifest({ rootDir, bundleFormat });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected bundle manifest to load");
  }
  return result.manifest;
}

function writeBundleManifest(
  rootDir: string,
  relativePath: string,
  manifest: Record<string, unknown>,
) {
  mkdirSafe(path.dirname(path.join(rootDir, relativePath)));
  fs.writeFileSync(path.join(rootDir, relativePath), JSON.stringify(manifest), "utf-8");
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("bundle manifest parsing", () => {
  it.each([
    {
      name: "detects and loads Codex bundle manifests",
      bundleFormat: "codex" as const,
      setup: (rootDir: string) => {
        mkdirSafe(path.join(rootDir, ".codex-plugin"));
        mkdirSafe(path.join(rootDir, "skills"));
        mkdirSafe(path.join(rootDir, "hooks"));
        writeBundleManifest(rootDir, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH, {
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
        });
      },
      expected: {
        id: "sample-bundle",
        name: "Sample Bundle",
        description: "Codex fixture",
        bundleFormat: "codex",
        skills: ["skills"],
        hooks: ["hooks"],
        capabilities: expect.arrayContaining(["hooks", "skills", "mcpServers", "apps"]),
      },
    },
    {
      name: "detects and loads Claude bundle manifests from the component layout",
      bundleFormat: "claude" as const,
      setup: (rootDir: string) => {
        for (const relativeDir of [
          ".claude-plugin",
          "skill-packs/starter",
          "commands-pack",
          "agents-pack",
          "hooks-pack",
          "mcp",
          "lsp",
          "styles",
          "hooks",
        ]) {
          mkdirSafe(path.join(rootDir, relativeDir));
        }
        fs.writeFileSync(path.join(rootDir, "hooks", "hooks.json"), '{"hooks":[]}', "utf-8");
        fs.writeFileSync(
          path.join(rootDir, "settings.json"),
          '{"hideThinkingBlock":true}',
          "utf-8",
        );
        writeBundleManifest(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH, {
          name: "Claude Sample",
          description: "Claude fixture",
          skills: ["skill-packs/starter"],
          commands: "commands-pack",
          agents: "agents-pack",
          hooks: "hooks-pack",
          mcpServers: "mcp",
          lspServers: "lsp",
          outputStyles: "styles",
        });
      },
      expected: {
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
      },
    },
    {
      name: "detects and loads Cursor bundle manifests",
      bundleFormat: "cursor" as const,
      setup: (rootDir: string) => {
        for (const relativeDir of [
          ".cursor-plugin",
          "skills",
          ".cursor/commands",
          ".cursor/rules",
          ".cursor/agents",
        ]) {
          mkdirSafe(path.join(rootDir, relativeDir));
        }
        fs.writeFileSync(path.join(rootDir, ".cursor", "hooks.json"), '{"hooks":[]}', "utf-8");
        writeBundleManifest(rootDir, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH, {
          name: "Cursor Sample",
          description: "Cursor fixture",
          mcpServers: "./.mcp.json",
        });
        fs.writeFileSync(path.join(rootDir, ".mcp.json"), '{"servers":{}}', "utf-8");
      },
      expected: {
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
      },
    },
    {
      name: "detects manifestless Claude bundles from the default layout",
      bundleFormat: "claude" as const,
      setup: (rootDir: string) => {
        mkdirSafe(path.join(rootDir, "commands"));
        mkdirSafe(path.join(rootDir, "skills"));
        fs.writeFileSync(
          path.join(rootDir, "settings.json"),
          '{"hideThinkingBlock":true}',
          "utf-8",
        );
      },
      expected: (rootDir: string) => ({
        id: path.basename(rootDir).toLowerCase(),
        skills: ["skills", "commands"],
        settingsFiles: ["settings.json"],
        capabilities: expect.arrayContaining(["skills", "commands", "settings"]),
      }),
    },
  ] as const)("$name", ({ bundleFormat, setup, expected }) => {
    const rootDir = makeTempDir();
    setup(rootDir);

    expect(detectBundleManifestFormat(rootDir)).toBe(bundleFormat);
    expect(expectLoadedManifest(rootDir, bundleFormat)).toMatchObject(
      typeof expected === "function" ? expected(rootDir) : expected,
    );
  });

  it.each([
    {
      name: "resolves Claude bundle hooks from default and declared paths",
      setupKind: "default-hooks",
      expectedHooks: ["hooks/hooks.json"],
      hasHooksCapability: true,
    },
    {
      name: "resolves Claude bundle hooks from manifest-declared paths only",
      setupKind: "custom-hooks",
      expectedHooks: ["custom-hooks"],
      hasHooksCapability: true,
    },
    {
      name: "returns empty hooks for Claude bundles with no hooks directory",
      setupKind: "no-hooks",
      expectedHooks: [],
      hasHooksCapability: false,
    },
  ] as const)("$name", ({ setupKind, expectedHooks, hasHooksCapability }) => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, ".claude-plugin"));
    if (setupKind === "default-hooks") {
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
    } else if (setupKind === "custom-hooks") {
      mkdirSafe(path.join(rootDir, "custom-hooks"));
      fs.writeFileSync(
        path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH),
        JSON.stringify({
          name: "Custom Hook Plugin",
          hooks: "custom-hooks",
        }),
        "utf-8",
      );
    } else {
      mkdirSafe(path.join(rootDir, "skills"));
      fs.writeFileSync(
        path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH),
        JSON.stringify({ name: "No Hooks" }),
        "utf-8",
      );
    }
    const manifest = expectLoadedManifest(rootDir, "claude");
    expect(manifest.hooks).toEqual(expectedHooks);
    expect(manifest.capabilities.includes("hooks")).toBe(hasHooksCapability);
  });

  it("does not misclassify native index plugins as manifestless Claude bundles", () => {
    const rootDir = makeTempDir();
    mkdirSafe(path.join(rootDir, "commands"));
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {}", "utf-8");

    expect(detectBundleManifestFormat(rootDir)).toBeNull();
  });
});
