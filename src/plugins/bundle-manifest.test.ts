/** Tests bundle manifest parsing for Agent, Codex, Claude, Cursor, and OpenClaw formats. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
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
const clientMetadata = { name: "Sample.Bundle", description: "Bundle fixture", version: "1.2.3" };

const tempDirs: string[] = [];

function expectLoadedManifest(
  rootDir: string,
  bundleFormat: "agent" | "codex" | "claude" | "cursor",
) {
  const result = loadBundleManifest({ rootDir, bundleFormat });
  assert(result.ok);
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

function agentFixture(extra: Record<string, unknown> = {}, files: Record<string, unknown> = {}) {
  return fixture({ [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: agentManifest(extra), ...files });
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
      layout: "portable",
      bundleFormat: "agent",
      dirs: [],
      files: {
        "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Summarize\n---\n",
        "mcp.json": "{",
        [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: agentManifest({
          ...clientMetadata,
          unknown: true,
        }),
      },
      expected: {
        skills: ["skills"],
        capabilities: ["skills", "mcpServers"],
      },
    },
    {
      layout: "JSON5",
      bundleFormat: "codex",
      dirs: [],
      files: {
        [CODEX_BUNDLE_MANIFEST_RELATIVE_PATH]: `{
              // JSON5 comments and trailing commas.
              name: "Sample.Bundle", description: "Bundle fixture", version: "1.2.3",
              skills: "skills",
              hooks: "hooks",
              mcpServers: { sample: { command: "node", args: ["server.js"] } },
              apps: { sample: { title: "Sample App" } },
            }`,
      },
      expected: {
        skills: ["skills"],
        hooks: ["hooks"],
        capabilities: ["skills", "hooks", "mcpServers", "apps"],
      },
    },
    {
      layout: "component",
      bundleFormat: "claude",
      dirs: ["agents", "output-styles"],
      files: {
        "hooks/hooks.json": '{"hooks":[]}',
        "settings.json": '{"hideThinkingBlock":true}',
        [CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH]: {
          ...clientMetadata,
          skills: ["skill-packs/starter"],
          commands: "commands-pack",
          agents: "agents",
          hooks: "hooks-pack",
          mcpServers: "mcp",
          lspServers: "lsp",
          outputStyles: "output-styles",
        },
      },
      expected: {
        skills: ["skill-packs/starter", "commands-pack", "agents", "output-styles"],
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
      layout: "component",
      bundleFormat: "cursor",
      dirs: ["skills", ".cursor/commands", ".cursor/rules", ".cursor/agents"],
      files: {
        ".cursor/hooks.json": '{"hooks":[]}',
        ".mcp.json": '{"servers":{}}',
        [CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH]: {
          ...clientMetadata,
          mcpServers: "./.mcp.json",
        },
      },
      expected: {
        skills: ["skills", ".cursor/commands"],
        capabilities: ["skills", "commands", "agents", "hooks", "rules", "mcpServers"],
      },
    },
    {
      layout: "manifestless",
      bundleFormat: "claude",
      dirs: ["commands", "skills"],
      files: {
        "settings.json": '{"hideThinkingBlock":true}',
      },
      expected: (rootDir: string) => ({
        name: undefined,
        description: undefined,
        version: undefined,
        id: path.basename(rootDir).toLowerCase(),
        skills: ["skills", "commands"],
        settingsFiles: ["settings.json"],
        capabilities: ["skills", "commands", "settings"],
      }),
    },
  ] as const)(
    "detects and loads $bundleFormat $layout layout",
    ({ bundleFormat, files, dirs, expected }) => {
      const rootDir = fixture(files, dirs);

      expect(detectBundleManifestFormat(rootDir)).toBe(bundleFormat);
      expect(expectLoadedManifest(rootDir, bundleFormat)).toEqual({
        ...clientMetadata,
        id: "sample-bundle",
        bundleFormat,
        settingsFiles: [],
        hooks: [],
        ...(typeof expected === "function" ? expected(rootDir) : expected),
      });
    },
  );

  it("inspects Claude LSP stdio servers", () => {
    const rootDir = fixture({
      [CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH]: { name: "lsp", lspServers: ".lsp.json" },
      ".lsp.json": {
        lspServers: {
          "typescript-lsp": { command: "typescript-language-server", args: ["--stdio"] },
        },
      },
    });
    expect(
      inspectBundleLspRuntimeSupport({ pluginId: "lsp", rootDir, bundleFormat: "claude" }),
    ).toEqual({
      supportedServerNames: ["typescript-lsp"],
      unsupportedServerNames: [],
      diagnostics: [],
    });
  });

  it("keeps client-specific and native formats ahead of portable Agent Plugins", () => {
    const claudeRoot = agentFixture(
      {},
      {
        [CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH]: { name: "Claude" },
      },
    );
    expect(detectBundleManifestFormat(claudeRoot)).toBe("claude");

    const nativeRoot = agentFixture(
      {},
      {
        "openclaw.plugin.json": { id: "native", configSchema: { type: "object" } },
      },
    );
    expect(detectBundleManifestFormat(nativeRoot)).toBeNull();

    const entryRoot = agentFixture({}, { "index.ts": "export default {}" });
    expect(detectBundleManifestFormat(entryRoot)).toBe("agent");
  });

  it.each([
    ["native entry", "wrong", { "index.ts": "export default {}" }, null],
    [
      "Claude markers",
      undefined,
      { "skills/example/SKILL.md": "---\ndescription: Example\n---\n" },
      "claude",
    ],
    ["no markers", "wrong", {}, null],
  ] as const)("falls through invalid Agent schema to %s", (_name, $schema, files, expected) => {
    const rootDir = fixture({
      [AGENT_BUNDLE_MANIFEST_RELATIVE_PATH]: { name: "not-agent", $schema },
      ...files,
    });

    expect(detectBundleManifestFormat(rootDir)).toBe(expected);
    expectLoadError(rootDir, "agent", `expected $schema ${AGENT_BUNDLE_MANIFEST_SCHEMA}`);
  });

  it("rejects Agent Plugins manifests with missing or empty names", () => {
    for (const name of [undefined, "   "]) {
      const rootDir = agentFixture({ name });
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
    const rootDir = agentFixture({}, { skills: "not a directory" });

    expect(expectLoadedManifest(rootDir, "agent").skills).toStrictEqual([]);
  });

  it("loads ai.openclaw activation like an equivalent Claude bundle", () => {
    const activation = {
      onStartup: true,
      onCommands: [" summarize ", ""],
      onCapabilities: ["tool", "unknown"],
    };
    const agentRoot = agentFixture({
      extensions: { "ai.openclaw": { activation, futureField: { enabled: true } } },
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
    "invalid",
    { "ai.openclaw": "invalid" },
    { "com.example": { activation: { onStartup: true } } },
  ])("ignores unsupported extensions %j", (extensions) => {
    const rootDir = agentFixture({ extensions });

    expect(expectLoadedManifest(rootDir, "agent").activation).toBeUndefined();
  });

  it.each(["agent", "codex"] as const)("rejects non-object %s manifests", (bundleFormat) => {
    const manifestRelativePath =
      bundleFormat === "agent"
        ? AGENT_BUNDLE_MANIFEST_RELATIVE_PATH
        : CODEX_BUNDLE_MANIFEST_RELATIVE_PATH;
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
