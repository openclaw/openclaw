// Command spec tests cover skill-provided command metadata and filtering.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";

const bundleCommandState = vi.hoisted<{ plugins: PluginManifestRecord[] }>(() => ({ plugins: [] }));

const skillsLoggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      ...skillsLoggerMock,
    }),
  };
});

vi.mock("../../plugins/plugin-registry-contributions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-registry-contributions.js")>()),
  loadPluginManifestRegistryForPluginRegistry: () => ({
    diagnostics: [],
    plugins: bundleCommandState.plugins,
  }),
}));

vi.mock("../loading/workspace-skill-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../loading/workspace-skill-loader.js")>()),
  loadVisibleSkills: () => [],
}));

const tempDirs = createTempDirTracker();

beforeEach(() => {
  vi.resetModules();
  bundleCommandState.plugins = [];
  skillsLoggerMock.debug.mockClear();
  skillsLoggerMock.trace.mockClear();
});

afterEach(() => {
  bundleCommandState.plugins = [];
  tempDirs.cleanup();
});

describe("buildWorkspaceSkillCommandSpecs", () => {
  it("uses shared user-invocable skill exposure policy", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [
        createFixtureSkillEntry("visible"),
        createFixtureSkillEntry("hidden-by-exposure", {
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: false,
          },
        }),
        createFixtureSkillEntry("hidden-by-invocation", {
          invocation: {
            userInvocable: false,
            disableModelInvocation: false,
          },
        }),
      ],
    });

    expect(specs.map((spec) => spec.skillName)).toEqual(["visible"]);
  });

  it("preserves workspace skill descriptions for provider-specific limits", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const prefix = "a".repeat(98);
    const entry = createFixtureSkillEntry("emoji-skill");
    entry.skill.displayName = "Emoji Skill";
    entry.skill.description = `${prefix}😀 extra text beyond the limit`;

    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [entry],
    });

    expect(specs[0]?.displayName).toBe("Emoji Skill");
    expect(specs[0]?.description).toBe(entry.skill.description);
    expect(specs[0]?.skillFile).toBe(entry.skill.filePath);
    expect(specs[0]).not.toHaveProperty("skillFileHost");
  });

  it("preserves bundle command descriptions for provider-specific limits", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const prefix = "a".repeat(98);
    const description = `${prefix}😀 extra text beyond the limit`;
    const workspaceDir = tempDirs.make("openclaw-command-specs-");
    const pluginRoot = path.join(workspaceDir, "bundle-plugin");
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "commands"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "bundle-plugin" }),
    );
    await fs.writeFile(
      path.join(pluginRoot, "commands", "bundle-emoji.md"),
      `---\nname: bundle-emoji\ndescription: ${description}\n---\nRun the bundled command.\n`,
    );
    bundleCommandState.plugins = [
      createPluginManifestRecordFixture({
        id: "bundle-plugin",
        format: "bundle",
        bundleFormat: "claude",
        bundleCapabilities: ["commands"],
        origin: "global",
        rootDir: pluginRoot,
      }),
    ];

    const specs = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      entries: [],
      config: { plugins: { entries: { "bundle-plugin": { enabled: true } } } },
    });

    expect(specs[0]).toMatchObject({
      skillName: "bundle-emoji",
      description,
      promptTemplate: "Run the bundled command.",
    });
  });

  it("bounds the skill command debug cache and re-logs evicted keys", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const entries = [];
    for (let index = 0; index < 1025; index += 1) {
      entries.push(createFixtureSkillEntry(`raw ${index}`));
    }

    buildWorkspaceSkillCommandSpecs("/workspace", { entries });
    expect(skillsLoggerMock.trace).toHaveBeenCalledTimes(1025);

    buildWorkspaceSkillCommandSpecs("/workspace", { entries: [entries[0]!] });
    expect(skillsLoggerMock.trace).toHaveBeenCalledTimes(1026);
  });
});
