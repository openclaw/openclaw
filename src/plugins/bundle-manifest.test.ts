/** Tests bundle manifest parsing for Agent, Codex, Claude, Cursor, and OpenClaw formats. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_BUNDLE_MANIFEST_RELATIVE_PATH,
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

const AGENT_BUNDLE_MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

type BundlePluginManifest = Extract<
  ReturnType<typeof loadBundleManifest>,
  { ok: true }
>["manifest"];

type ReadonlyBundleManifestExpectation = Omit<
  BundlePluginManifest,
  "capabilities" | "hooks" | "settingsFiles" | "skills"
> & {
  capabilities: readonly string[];
  hooks: readonly string[];
  settingsFiles?: readonly string[];
  skills: readonly string[];
};

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-bundle-manifest", tempDirs);
}

const mkdirSafe = mkdirSafeDir;

function expectLoadedManifest(
  rootDir: string,
  bundleFormat: "agent" | "codex" | "claude" | "cursor",
) {
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
  writeBundleFixtureFile(rootDir, relativePath, manifest);
}

function writeBundleFixtureFile(rootDir: string, relativePath: string, value: unknown) {
  mkdirSafe(path.dirname(path.join(rootDir, relativePath)));
  fs.writeFileSync(
    path.join(rootDir, relativePath),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf-8",
  );
}

function writeBundleFixtureFiles(rootDir: string, files: Readonly<Record<string, unknown>>) {
  Object.entries(files).forEach(([relativePath, value]) => {
    writeBundleFixtureFile(rootDir, relativePath, value);
  });
}

function setupBundleFixture(params: {
  rootDir: string;
  dirs?: readonly string[];
  jsonFiles?: Readonly<Record<string, unknown>>;
  textFiles?: Readonly<Record<string, string>>;
  manifestRelativePath?: string;
  manifest?: Record<string, unknown>;
}) {
  for (const relativeDir of params.dirs ?? []) {
    mkdirSafe(path.join(params.rootDir, relativeDir));
  }
  writeBundleFixtureFiles(params.rootDir, params.jsonFiles ?? {});
  writeBundleFixtureFiles(params.rootDir, params.textFiles ?? {});
  if (params.manifestRelativePath && params.manifest) {
    writeBundleManifest(params.rootDir, params.manifestRelativePath, params.manifest);
  }
}

function expectBundleManifest(params: {
  rootDir: string;
  bundleFormat: "agent" | "codex" | "claude" | "cursor";
  expected: ReadonlyBundleManifestExpectation;
}) {
  expect(detectBundleManifestFormat(params.rootDir)).toBe(params.bundleFormat);
  expect(expectLoadedManifest(params.rootDir, params.bundleFormat)).toEqual(params.expected);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("bundle manifest parsing", () => {
  it("does not treat openclaw.bundle.json as a bundle manifest", () => {
    const rootDir = makeTempDir();
    writeBundleManifest(rootDir, "openclaw.bundle.json", {
      name: "Not Real",
      skills: ["skills"],
    });

    expect(detectBundleManifestFormat(rootDir)).toBeNull();
  });

  it.each([
    {
      name: "detects and loads Agent Plugins bundles from the portable layout",
      bundleFormat: "agent" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: ["skills/summarize"],
          textFiles: {
            "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Summarize\n---\n",
            "mcp.json": "{",
          },
          manifestRelativePath: AGENT_BUNDLE_MANIFEST_RELATIVE_PATH,
          manifest: {
            $schema: AGENT_BUNDLE_MANIFEST_SCHEMA,
            name: "Portable.Bundle",
            description: "Agent Plugins fixture",
            version: "1.2.3",
            unknown: true,
          },
        });
      },
      expected: {
        id: "portable-bundle",
        name: "Portable.Bundle",
        description: "Agent Plugins fixture",
        version: "1.2.3",
        bundleFormat: "agent",
        skills: ["skills"],
        settingsFiles: [],
        hooks: [],
        capabilities: ["skills", "mcpServers"],
      },
    },
    {
      name: "detects and loads Codex bundle manifests",
      bundleFormat: "codex" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: [".codex-plugin", "skills", "hooks"],
          textFiles: {
            [CODEX_BUNDLE_MANIFEST_RELATIVE_PATH]: `{
              // Client manifests support JSON5 comments and trailing commas.
              name: "Sample Bundle",
              description: "Codex fixture",
              skills: "skills",
              hooks: "hooks",
              mcpServers: { sample: { command: "node", args: ["server.js"] } },
              apps: { sample: { title: "Sample App" } },
            }`,
          },
        });
      },
      expected: {
        id: "sample-bundle",
        name: "Sample Bundle",
        description: "Codex fixture",
        version: undefined,
        bundleFormat: "codex",
        skills: ["skills"],
        settingsFiles: [],
        hooks: ["hooks"],
        capabilities: ["skills", "hooks", "mcpServers", "apps"],
      },
    },
    {
      name: "detects and loads Claude bundle manifests from the component layout",
      bundleFormat: "claude" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: [
            ".claude-plugin",
            "skill-packs/starter",
            "commands-pack",
            "agents-pack",
            "hooks-pack",
            "mcp",
            "lsp",
            "styles",
            "hooks",
          ],
          textFiles: {
            "hooks/hooks.json": '{"hooks":[]}',
            "settings.json": '{"hideThinkingBlock":true}',
          },
          manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
          manifest: {
            name: "Claude Sample",
            description: "Claude fixture",
            skills: ["skill-packs/starter"],
            commands: "commands-pack",
            agents: "agents-pack",
            hooks: "hooks-pack",
            mcpServers: "mcp",
            lspServers: "lsp",
            outputStyles: "styles",
          },
        });
      },
      expected: {
        id: "claude-sample",
        name: "Claude Sample",
        description: "Claude fixture",
        version: undefined,
        bundleFormat: "claude" as const,
        skills: ["skill-packs/starter", "commands-pack", "agents-pack", "styles"],
        settingsFiles: ["settings.json"],
        hooks: ["hooks/hooks.json", "hooks-pack"],
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
      },
    },
    {
      name: "detects and loads Cursor bundle manifests",
      bundleFormat: "cursor" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: [".cursor-plugin", "skills", ".cursor/commands", ".cursor/rules", ".cursor/agents"],
          textFiles: {
            ".cursor/hooks.json": '{"hooks":[]}',
            ".mcp.json": '{"servers":{}}',
          },
          manifestRelativePath: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
          manifest: {
            name: "Cursor Sample",
            description: "Cursor fixture",
            mcpServers: "./.mcp.json",
          },
        });
      },
      expected: {
        id: "cursor-sample",
        name: "Cursor Sample",
        description: "Cursor fixture",
        version: undefined,
        bundleFormat: "cursor",
        skills: ["skills", ".cursor/commands"],
        settingsFiles: [],
        hooks: [],
        capabilities: ["skills", "commands", "agents", "hooks", "rules", "mcpServers"],
      },
    },
    {
      name: "detects manifestless Claude bundles from the default layout",
      bundleFormat: "claude" as const,
      setup: (rootDir: string) => {
        setupBundleFixture({
          rootDir,
          dirs: ["commands", "skills"],
          textFiles: {
            "settings.json": '{"hideThinkingBlock":true}',
          },
        });
      },
      expected: (rootDir: string) => ({
        id: path.basename(rootDir).toLowerCase(),
        name: undefined,
        description: undefined,
        version: undefined,
        bundleFormat: "claude" as const,
        skills: ["skills", "commands"],
        settingsFiles: ["settings.json"],
        hooks: [],
        capabilities: ["skills", "commands", "settings"],
      }),
    },
  ] as const)("$name", ({ bundleFormat, setup, expected }) => {
    const rootDir = makeTempDir();
    setup(rootDir);

    expectBundleManifest({
      rootDir,
      bundleFormat,
      expected: typeof expected === "function" ? expected(rootDir) : expected,
    });
  });

  it("detects Link-style Codex bundles with skills and MCP servers", () => {
    const rootDir = makeTempDir();
    setupBundleFixture({
      rootDir,
      dirs: [".codex-plugin", "skills/create-payment-credential"],
      textFiles: {
        ".mcp.json": JSON.stringify({
          mcpServers: {
            link: {
              command: "pnpx",
              args: ["@stripe/link-cli", "--mcp"],
            },
          },
        }),
      },
      manifestRelativePath: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
      manifest: {
        name: "link",
        version: "0.2.1",
        description: "Secure, one-time-use payment credentials from Link",
        homepage: "https://link.com/agents",
        repository: "https://github.com/stripe/link-cli",
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        interface: {
          displayName: "Link",
          category: "Finance",
        },
      },
    });

    expectBundleManifest({
      rootDir,
      bundleFormat: "codex",
      expected: {
        id: "link",
        name: "link",
        version: "0.2.1",
        description: "Secure, one-time-use payment credentials from Link",
        bundleFormat: "codex",
        skills: ["./skills/"],
        settingsFiles: [],
        hooks: [],
        capabilities: expect.arrayContaining(["skills", "mcpServers"]),
      },
    });
  });

  it("keeps client-specific and native formats ahead of portable Agent Plugins", () => {
    const claudeRoot = makeTempDir();
    setupBundleFixture({
      rootDir: claudeRoot,
      dirs: [".claude-plugin"],
      jsonFiles: {
        [CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH]: { name: "Claude" },
        [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: {
          $schema: AGENT_BUNDLE_MANIFEST_SCHEMA,
          name: "Agent",
        },
      },
    });
    expect(detectBundleManifestFormat(claudeRoot)).toBe("claude");

    const nativeRoot = makeTempDir();
    writeBundleFixtureFiles(nativeRoot, {
      "openclaw.plugin.json": { id: "native", configSchema: { type: "object" } },
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: {
        $schema: AGENT_BUNDLE_MANIFEST_SCHEMA,
        name: "Agent",
      },
    });
    expect(detectBundleManifestFormat(nativeRoot)).toBeNull();

    const entryRoot = makeTempDir();
    writeBundleFixtureFiles(entryRoot, {
      "index.ts": "export default {}",
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: {
        $schema: AGENT_BUNDLE_MANIFEST_SCHEMA,
        name: "Agent",
      },
    });
    expect(detectBundleManifestFormat(entryRoot)).toBe("agent");
  });

  it.each([
    {
      name: "wrong schema falls through to native entry detection",
      manifest: { $schema: "https://wrong.example/plugin.schema.json", name: "not-agent" },
      files: { "index.ts": "export default {}" },
      expected: null,
    },
    {
      name: "missing schema falls through to manifestless Claude markers",
      manifest: { name: "not-agent" },
      files: { "skills/example/SKILL.md": "---\ndescription: Example\n---\n" },
      expected: "claude",
    },
    {
      name: "wrong schema without fallback markers is not a bundle",
      manifest: { $schema: "https://wrong.example/plugin.schema.json", name: "not-agent" },
      files: {},
      expected: null,
    },
  ])("$name", ({ manifest, files, expected }) => {
    const rootDir = makeTempDir();
    writeBundleFixtureFiles(rootDir, {
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: manifest,
      ...files,
    });

    expect(detectBundleManifestFormat(rootDir)).toBe(expected);
  });

  it.each([
    { name: "missing schema", manifest: { name: "portable" } },
    {
      name: "wrong schema",
      manifest: { $schema: "https://wrong.example/plugin.schema.json", name: "portable" },
    },
  ])("rejects Agent Plugins manifests with $name", ({ manifest }) => {
    const rootDir = makeTempDir();
    writeBundleManifest(rootDir, AGENT_BUNDLE_MANIFEST_RELATIVE_PATH, manifest);

    const result = loadBundleManifest({ rootDir, bundleFormat: "agent" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`expected $schema ${AGENT_BUNDLE_MANIFEST_SCHEMA}`);
    }
  });

  it("rejects Agent Plugins manifests with missing or empty names", () => {
    for (const name of [undefined, "   "]) {
      const rootDir = makeTempDir();
      writeBundleManifest(rootDir, AGENT_BUNDLE_MANIFEST_RELATIVE_PATH, {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        ...(name === undefined ? {} : { name }),
      });
      const result = loadBundleManifest({ rootDir, bundleFormat: "agent" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("name must be a non-empty string");
      }
    }
  });

  it("requires strict JSON only for Agent Plugins manifests", () => {
    const rootDir = makeTempDir();
    writeBundleFixtureFile(
      rootDir,
      AGENT_BUNDLE_MANIFEST_RELATIVE_PATH,
      '{ name: "not strict JSON", }',
    );

    const result = loadBundleManifest({ rootDir, bundleFormat: "agent" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse plugin manifest");
    }
  });

  it("does not expose Agent Plugins skills when skills is not a directory", () => {
    const rootDir = makeTempDir();
    writeBundleFixtureFiles(rootDir, {
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: {
        $schema: AGENT_BUNDLE_MANIFEST_SCHEMA,
        name: "portable",
      },
      skills: "not a directory",
    });

    expect(expectLoadedManifest(rootDir, "agent").skills).toStrictEqual([]);
  });

  it("loads ai.openclaw activation like an equivalent Claude bundle", () => {
    const activation = {
      onStartup: true,
      onCommands: [" summarize ", ""],
      onCapabilities: ["tool", "unknown"],
    };
    const agentRoot = makeTempDir();
    writeBundleManifest(agentRoot, AGENT_BUNDLE_MANIFEST_RELATIVE_PATH, {
      $schema: AGENT_BUNDLE_MANIFEST_SCHEMA,
      name: "portable",
      extensions: {
        "ai.openclaw": { activation, futureField: { enabled: true } },
      },
    });
    const claudeRoot = makeTempDir();
    writeBundleManifest(claudeRoot, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH, {
      name: "claude",
      activation,
    });

    const agentActivation = expectLoadedManifest(agentRoot, "agent").activation;
    expect(agentActivation).toEqual({
      onStartup: true,
      onCommands: ["summarize"],
      onCapabilities: ["tool"],
    });
    expect(agentActivation).toEqual(expectLoadedManifest(claudeRoot, "claude").activation);
  });

  it.each([
    { name: "non-object extensions", extensions: "invalid" },
    {
      name: "non-object ai.openclaw extension",
      extensions: { "ai.openclaw": "invalid" },
    },
    {
      name: "unknown extension namespace",
      extensions: { "com.example": { activation: { onStartup: true } } },
    },
  ])("ignores $name", ({ extensions }) => {
    const rootDir = makeTempDir();
    writeBundleManifest(rootDir, AGENT_BUNDLE_MANIFEST_RELATIVE_PATH, {
      $schema: AGENT_BUNDLE_MANIFEST_SCHEMA,
      name: "portable",
      extensions,
    });

    expect(expectLoadedManifest(rootDir, "agent").activation).toBeUndefined();
  });

  it.each([
    {
      name: "rejects Agent Plugins manifests that parse to non-objects",
      bundleFormat: "agent" as const,
      manifestRelativePath: AGENT_BUNDLE_MANIFEST_RELATIVE_PATH,
    },
    {
      name: "rejects JSON5 Codex bundle manifests that parse to non-objects",
      bundleFormat: "codex" as const,
      manifestRelativePath: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
    },
  ] as const)("$name", ({ bundleFormat, manifestRelativePath }) => {
    const rootDir = makeTempDir();
    setupBundleFixture({
      rootDir,
      dirs: [path.dirname(manifestRelativePath)],
      textFiles: {
        [manifestRelativePath]:
          bundleFormat === "agent" ? '"still not an object"' : "'still not an object'",
      },
    });

    const result = loadBundleManifest({ rootDir, bundleFormat });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest must be an object");
    }
  });

  it("exposes default Claude hooks without a hooks declaration", () => {
    const rootDir = makeTempDir();
    writeBundleFixtureFiles(rootDir, {
      [CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH]: { name: "default-hooks" },
      "hooks/hooks.json": { hooks: [] },
    });
    const manifest = expectLoadedManifest(rootDir, "claude");
    expect(manifest.hooks).toEqual(["hooks/hooks.json"]);
    expect(manifest.capabilities).toContain("hooks");
  });

  it("does not misclassify native index plugins as manifestless Claude bundles", () => {
    const rootDir = makeTempDir();
    setupBundleFixture({
      rootDir,
      dirs: ["commands"],
      textFiles: { "index.ts": "export default {}" },
    });

    expect(detectBundleManifestFormat(rootDir)).toBeNull();
  });
});
