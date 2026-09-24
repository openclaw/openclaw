// Command spec tests cover skill-provided command metadata and filtering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";

const bundleCommandState = vi.hoisted(() => ({
  entries: [] as Array<{
    pluginId: string;
    rawName: string;
    description: string;
    promptTemplate: string;
    sourceFilePath: string;
  }>,
}));

const registeredCommands = vi.hoisted(() => ({
  entries: [] as Array<{ command: { name: string; nativeNames?: Record<string, string> } }>,
}));

vi.mock("../../plugins/plugin-command-registry.js", () => ({
  resolveSelectedPluginCommandRegistry: () => ({ commands: registeredCommands.entries }),
}));

const skillsLoggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => skillsLoggerMock,
}));

vi.mock("../../plugins/bundle-commands.js", () => ({
  loadEnabledClaudeBundleCommands: () => bundleCommandState.entries,
}));

vi.mock("../loading/workspace-skill-loader.js", () => ({
  filterWorkspaceSkills: (entries: SkillEntry[]) => entries,
  loadVisibleSkills: () => [],
}));

beforeEach(() => {
  vi.resetModules();
  bundleCommandState.entries = [];
  registeredCommands.entries = [];
  skillsLoggerMock.debug.mockClear();
  skillsLoggerMock.trace.mockClear();
});

afterEach(() => {
  bundleCommandState.entries = [];
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
  });

  it("preserves bundle command descriptions for provider-specific limits", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const prefix = "a".repeat(98);
    const description = `${prefix}😀 extra text beyond the limit`;
    bundleCommandState.entries = [
      {
        pluginId: "bundle-plugin",
        rawName: "bundle-emoji",
        description,
        promptTemplate: "Run the bundled command.",
        sourceFilePath: "/plugins/bundle-plugin/commands/bundle-emoji.md",
      },
    ];

    const specs = buildWorkspaceSkillCommandSpecs("/workspace", {
      entries: [],
    });

    expect(specs[0]).toMatchObject({
      skillName: "bundle-emoji",
      description,
      promptTemplate: "Run the bundled command.",
    });
  });

  it("does not let a managed short name displace a bundle command or a truncated alias", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const first = createFixtureSkillEntry("s_review_00000000000000000001", {
      source: "openclaw-library",
    });
    first.frontmatter.name = "review";
    bundleCommandState.entries = [
      {
        pluginId: "review-plugin",
        rawName: "review",
        description: "Review a change",
        promptTemplate: "Review $ARGUMENTS",
        sourceFilePath: "/plugins/review/commands/review.md",
      },
    ];
    const specs = buildWorkspaceSkillCommandSpecs("/workspace", { entries: [first] });
    expect(specs.map((spec) => spec.name)).toEqual([first.skill.name, "review"]);
    bundleCommandState.entries[0]!.rawName = first.skill.name;
    const copiedIdentity = buildWorkspaceSkillCommandSpecs("/workspace", { entries: [first] });
    expect(copiedIdentity.map((spec) => spec.name)).toEqual(["review", first.skill.name + "_2"]);
    expect(copiedIdentity[1]?.aliases).toBeUndefined();
    bundleCommandState.entries = [];
    first.frontmatter.name = "x".repeat(32) + "-first";
    const second = createFixtureSkillEntry("s_review_00000000000000000002", {
      source: "openclaw-library",
    });
    second.frontmatter.name = "x".repeat(32) + "-second";
    expect(
      buildWorkspaceSkillCommandSpecs("/workspace", { entries: [first, second] }).map(
        (spec) => spec.name,
      ),
    ).toEqual([first.skill.name, second.skill.name]);
  });

  it.each(["text", "native"])(
    "reserves registered plugin %s command names before offering a short alias",
    async (surface) => {
      const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
      const entry = createFixtureSkillEntry("s_review_00000000000000000001", {
        source: "openclaw-library",
      });
      entry.frontmatter.name = "review";
      registeredCommands.entries = [
        {
          command:
            surface === "text"
              ? { name: "review" }
              : { name: "plugin_review", nativeNames: { discord: "review" } },
        },
      ];
      expect(buildWorkspaceSkillCommandSpecs("/workspace", { entries: [entry] })[0]?.name).toBe(
        entry.skill.name,
      );
    },
  );

  it("bounds the skill command debug cache and re-logs evicted keys", async () => {
    const { buildWorkspaceSkillCommandSpecs } = await import("./command-specs.js");
    const entries = [];
    for (let index = 0; index < 1025; index += 1) {
      entries.push({
        pluginId: "bundle-plugin",
        rawName: `raw ${index}`,
        description: "Run the bundled command.",
        promptTemplate: "Run the bundled command.",
        sourceFilePath: `/plugins/bundle-plugin/commands/raw-${index}.md`,
      });
    }

    bundleCommandState.entries = entries;
    buildWorkspaceSkillCommandSpecs("/workspace", { entries: [] });
    expect(skillsLoggerMock.debug).toHaveBeenCalledTimes(1025);

    bundleCommandState.entries = [entries[0]!];
    buildWorkspaceSkillCommandSpecs("/workspace", { entries: [] });
    expect(skillsLoggerMock.debug).toHaveBeenCalledTimes(1026);
  });
});
