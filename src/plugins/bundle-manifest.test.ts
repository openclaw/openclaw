/** Tests bundle manifest parsing for Agent, Codex, Claude, Cursor, and OpenClaw formats. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  detectBundleManifestFormat,
  loadBundleManifest,
} from "./bundle-manifest.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const AGENT_BUNDLE_MANIFEST_RELATIVE_PATH = "plugin.json";
const CODEX_BUNDLE_MANIFEST_RELATIVE_PATH = ".codex-plugin/plugin.json";
const CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH = ".cursor-plugin/plugin.json";
const AGENT_BUNDLE_MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const tempDirs: string[] = [];

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

function writeBundleFixtureFile(rootDir: string, relativePath: string, value: unknown) {
  mkdirSafeDir(path.dirname(path.join(rootDir, relativePath)));
  fs.writeFileSync(
    path.join(rootDir, relativePath),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf-8",
  );
}

function fixture(files: Readonly<Record<string, unknown>>, dirs: readonly string[] = []) {
  const rootDir = makeTrackedTempDir("openclaw-bundle-manifest", tempDirs);
  for (const relativeDir of dirs) {
    mkdirSafeDir(path.join(rootDir, relativeDir));
  }
  for (const [relativePath, value] of Object.entries(files)) {
    writeBundleFixtureFile(rootDir, relativePath, value);
  }
  return rootDir;
}

function agentManifest(extra: Record<string, unknown> = {}) {
  return { $schema: AGENT_BUNDLE_MANIFEST_SCHEMA, name: "portable", ...extra };
}

function expectLoadError(rootDir: string, bundleFormat: "agent" | "codex", error: string) {
  expect(loadBundleManifest({ rootDir, bundleFormat })).toMatchObject({
    ok: false,
    error: expect.stringContaining(error),
  });
}

afterEach(() => cleanupTrackedTempDirs(tempDirs));

describe("bundle manifest parsing", () => {
  it("does not treat openclaw.bundle.json as a bundle manifest", () => {
    const rootDir = fixture({
      "openclaw.bundle.json": { name: "Not Real", skills: ["skills"] },
    });

    expect(detectBundleManifestFormat(rootDir)).toBeNull();
  });

  it.each([
    {
      name: "detects and loads Agent Plugins bundles from the portable layout",
      bundleFormat: "agent" as const,
      dirs: [],
      files: {
        "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Summarize\n---\n",
        "mcp.json": "{",
        [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: {
          $schema: AGENT_BUNDLE_MANIFEST_SCHEMA,
          name: "Portable.Bundle",
          description: "Agent Plugins fixture",
          version: "1.2.3",
          unknown: true,
        },
      },
      expected: {
        id: "portable-bundle",
        name: "Portable.Bundle",
        description: "Agent Plugins fixture",
        version: "1.2.3",
        bundleFormat: "agent",
        skills: ["skills"],
        capabilities: ["skills", "mcpServers"],
      },
    },
    {
      name: "detects and loads Codex bundle manifests",
      bundleFormat: "codex" as const,
      dirs: [".codex-plugin", "skills", "hooks"],
      files: {
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
      expected: {
        id: "sample-bundle",
        name: "Sample Bundle",
        description: "Codex fixture",
        bundleFormat: "codex",
        skills: ["skills"],
        hooks: ["hooks"],
        capabilities: ["skills", "hooks", "mcpServers", "apps"],
      },
    },
    {
      name: "detects and loads Claude bundle manifests from the component layout",
      bundleFormat: "claude" as const,
      dirs: [
        "skill-packs/starter",
        "commands-pack",
        "agents-pack",
        "hooks-pack",
        "mcp",
        "lsp",
        "styles",
      ],
      files: {
        "hooks/hooks.json": '{"hooks":[]}',
        "settings.json": '{"hideThinkingBlock":true}',
        [CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH]: {
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
      },
      expected: {
        id: "claude-sample",
        name: "Claude Sample",
        description: "Claude fixture",
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
      dirs: [".cursor-plugin", "skills", ".cursor/commands", ".cursor/rules", ".cursor/agents"],
      files: {
        ".cursor/hooks.json": '{"hooks":[]}',
        ".mcp.json": '{"servers":{}}',
        [CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH]: {
          name: "Cursor Sample",
          description: "Cursor fixture",
          mcpServers: "./.mcp.json",
        },
      },
      expected: {
        id: "cursor-sample",
        name: "Cursor Sample",
        description: "Cursor fixture",
        bundleFormat: "cursor",
        skills: ["skills", ".cursor/commands"],
        capabilities: ["skills", "commands", "agents", "hooks", "rules", "mcpServers"],
      },
    },
    {
      name: "detects manifestless Claude bundles from the default layout",
      bundleFormat: "claude" as const,
      dirs: ["commands", "skills"],
      files: {
        "settings.json": '{"hideThinkingBlock":true}',
      },
      expected: (rootDir: string) => ({
        id: path.basename(rootDir).toLowerCase(),
        bundleFormat: "claude" as const,
        skills: ["skills", "commands"],
        settingsFiles: ["settings.json"],
        capabilities: ["skills", "commands", "settings"],
      }),
    },
  ] as const)("$name", ({ bundleFormat, files, dirs, expected }) => {
    const rootDir = fixture(files, dirs);

    expect(detectBundleManifestFormat(rootDir)).toBe(bundleFormat);
    expect(expectLoadedManifest(rootDir, bundleFormat)).toEqual({
      name: undefined,
      description: undefined,
      version: undefined,
      settingsFiles: [],
      hooks: [],
      ...(typeof expected === "function" ? expected(rootDir) : expected),
    });
  });

  it("keeps client-specific and native formats ahead of portable Agent Plugins", () => {
    const claudeRoot = fixture({
      [CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH]: { name: "Claude" },
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: agentManifest({ name: "Agent" }),
    });
    expect(detectBundleManifestFormat(claudeRoot)).toBe("claude");

    const nativeRoot = fixture({
      "openclaw.plugin.json": { id: "native", configSchema: { type: "object" } },
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: agentManifest({ name: "Agent" }),
    });
    expect(detectBundleManifestFormat(nativeRoot)).toBeNull();

    const entryRoot = fixture({
      "index.ts": "export default {}",
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: agentManifest({ name: "Agent" }),
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
    const rootDir = fixture({
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
    const rootDir = fixture({ [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: manifest });
    expectLoadError(rootDir, "agent", `expected $schema ${AGENT_BUNDLE_MANIFEST_SCHEMA}`);
  });

  it("rejects Agent Plugins manifests with missing or empty names", () => {
    for (const name of [undefined, "   "]) {
      const rootDir = fixture({
        [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: {
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          ...(name === undefined ? {} : { name }),
        },
      });
      expectLoadError(rootDir, "agent", "name must be a non-empty string");
    }
  });

  it("requires strict JSON only for Agent Plugins manifests", () => {
    const rootDir = fixture({
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: '{ name: "not strict JSON", }',
    });

    expectLoadError(rootDir, "agent", "failed to parse plugin manifest");
  });

  it("does not expose Agent Plugins skills when skills is not a directory", () => {
    const rootDir = fixture({
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: agentManifest(),
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
    const agentRoot = fixture({
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: agentManifest({
        extensions: {
          "ai.openclaw": { activation, futureField: { enabled: true } },
        },
      }),
    });
    const claudeRoot = fixture({
      [CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH]: { name: "claude", activation },
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
    const rootDir = fixture({
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: agentManifest({ extensions }),
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
    const rootDir = fixture({
      [manifestRelativePath]:
        bundleFormat === "agent" ? '"still not an object"' : "'still not an object'",
    });

    expectLoadError(rootDir, bundleFormat, "plugin manifest must be an object");
  });
});

describe("OpenAI packaged onboarding skill", () => {
  it("retains only a skill inside the declared packaged skill roots", () => {
    for (const onboardingSkill of [
      "./skills/setup/SKILL.md",
      "../outside/SKILL.md",
      "./other/SKILL.md",
    ]) {
      const rootDir = fixture({
        [CODEX_BUNDLE_MANIFEST_RELATIVE_PATH]: {
          name: "setup-demo",
          skills: "./skills",
          extensions: { "com.openai": { onboardingSkill } },
        },
      });
      const manifest = expectLoadedManifest(rootDir, "codex");
      expect(manifest.onboardingSkill).toBe(
        onboardingSkill.startsWith("./skills/") ? "skills/setup/SKILL.md" : undefined,
      );
    }
  });
});
