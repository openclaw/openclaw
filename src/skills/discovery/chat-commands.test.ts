import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import type { SkillCommandSpec } from "../types.js";
import {
  expandExplicitSkillReferences,
  resolveSkillCommandInvocation,
} from "./chat-command-invocation.js";

let listSkillCommandsForAgents: typeof import("./chat-commands.js").listSkillCommandsForAgents;
let listSkillCommandsForWorkspace: typeof import("./chat-commands.js").listSkillCommandsForWorkspace;
let lastCommandBuildOptions:
  | { pluginMetadataSnapshot?: unknown; librarySelections?: unknown }
  | undefined;

function makeCommand(name: string, skillName = name, description = "Demo"): SkillCommandSpec {
  return { name, skillName, description };
}

function expand(
  text: string,
  skillCommands: SkillCommandSpec[],
  allSkillCommands?: SkillCommandSpec[],
) {
  return expandExplicitSkillReferences({ text, skillCommands, allSkillCommands });
}

function agentConfig(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  skills?: string[],
): OpenClawConfig {
  return { agents: { entries, ...(skills ? { defaults: { skills } } : {}) } };
}

const tempDirs = createTempDirTracker();
const resolveNodeExecEligibilityMock = vi.hoisted(() =>
  vi.fn((_params: { agentId?: string }) => ({ canExec: false })),
);

async function workspace(name: string) {
  const dir = path.join(tempDirs.make("openclaw-skills-"), name);
  await fs.mkdir(dir);
  return dir;
}

// mock-isolation: Skill discovery uses an empty built-in registry to isolate skill filtering and naming.
vi.mock("../../auto-reply/commands-registry.data.js", () => ({
  listReservedChatSlashCommandNames: () => new Set<string>(),
}));

vi.mock("./command-specs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./command-specs.js")>();
  const fixtures: Record<string, string[]> = {
    main: ["demo-skill"],
    research: ["demo-skill", "extra-skill"],
    "shared-defaults": ["alpha-skill", "beta-skill", "hidden-skill"],
  };
  return {
    ...actual,
    buildWorkspaceSkillCommandSpecs: (dir, opts) => {
      lastCommandBuildOptions = opts;
      const entries = (fixtures[path.basename(dir)] ?? []).map((name) =>
        createFixtureSkillEntry(name),
      );
      return actual.buildWorkspaceSkillCommandSpecs(dir, { ...opts, entries });
    },
  } satisfies typeof actual;
});

vi.mock("../runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({}),
}));

// mock-isolation: Command-discovery tests supply node eligibility without opening host approval storage.
vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibilityAsync: resolveNodeExecEligibilityMock,
}));

// mock-isolation: Command discovery uses the eligibility fixture without reading host approval storage.
vi.mock("../../agents/exec-defaults.legacy.js", () => ({
  resolveNodeExecEligibilityLegacy: resolveNodeExecEligibilityMock,
}));

beforeAll(async () => {
  ({ listSkillCommandsForAgents, listSkillCommandsForWorkspace } =
    await import("./chat-commands.js"));
});

afterAll(() => tempDirs.cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  lastCommandBuildOptions = undefined;
  resolveNodeExecEligibilityMock.mockReturnValue({ canExec: false });
});

describe("skill commands", () => {
  it("preserves multiline args for /skill invocations", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo_skill first line\nsecond line",
      skillCommands: [makeCommand("demo_skill", "demo-skill")],
    });
    expect(invocation).toMatchObject({
      command: { name: "demo_skill" },
      args: "first line\nsecond line",
    });
  });
  it("treats only odd backslash runs as escaping a reference", () => {
    expect(
      expand(String.raw`Ignore \$demo_skill but resolve \\$demo_skill.`, [
        makeCommand("demo_skill", "demo-skill"),
      ]).skills.map((command) => command.name),
    ).toEqual(["demo_skill"]);
  });
  it("renders a leading bundle command template and leaves dollar-like bundle text literal", () => {
    const bundleCommand = {
      ...makeCommand("workflows_review", "workflows-review", "Review a workflow"),
      promptTemplate: "Review this workflow.\n\nFocus on:\n$ARGUMENTS",
      sourceFilePath: "/tmp/plugin/commands/workflows-review.md",
    };
    expect(expand("/workflows_review retries", [bundleCommand])).toEqual({
      body: "Review this workflow.\n\nFocus on:\nretries",
      skills: [bundleCommand],
    });
    expect(expand("Keep $workflows_review literal.", [bundleCommand])).toEqual({
      body: "Keep $workflows_review literal.",
      skills: [],
    });
  });

  it("leaves unknown leading slash commands byte-identical", () => {
    const text = "/compact with $demo_skill";
    expect(expand(text, [makeCommand("demo_skill", "demo-skill")])).toEqual({
      body: text,
      skills: [],
    });
  });

  it.each([
    ["/foo run it", "foo", "foo?", "foo!", "foo_2"],
    ["Run it with $foo_bar.", "foo_bar", "foo-bar", "foo:bar", "foo_bar_2"],
  ])(
    "prefers an available command for %s when hidden skill names collide",
    (text, name, availableName, hiddenName, allAvailableName) => {
      const available = makeCommand(name, availableName, "Allowed skill");
      const hidden = makeCommand(name, hiddenName, "Hidden skill");
      expect(expand(text, [available], [hidden, { ...available, name: allAvailableName }])).toEqual(
        {
          body: [
            "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
            `- ${available.skillName}`,
            "",
            "User request:",
            text,
          ].join("\n"),
          skills: [available],
        },
      );
    },
  );

  it("rejects a rendered skill reference that exceeds its prompt budget", () => {
    const text = "/demo_skill";
    expect(
      expand(text, [
        {
          ...makeCommand("demo_skill", "demo-skill"),
          modelVisible: false,
          skillFile: `/tmp/${"nested/".repeat(80)}SKILL.md`,
        },
      ]),
    ).toEqual({
      body: text,
      error:
        "Skill reference metadata is too long. Keep each rendered reference at 512 characters or less.",
      skills: [],
    });
  });

  it("rejects a combined reference prefix that exceeds its prompt budget", () => {
    const skillCommands = Array.from({ length: 8 }, (_, index) =>
      makeCommand(`skill_${index + 1}`, `skill-${index + 1}-${"x".repeat(110)}`),
    );
    const text = skillCommands.map((skill) => `$${skill.name}`).join(" ");
    expect(expand(text, skillCommands)).toEqual({
      body: text,
      error:
        "Combined skill reference metadata is too long. Use fewer or shorter skill references.",
      skills: [],
    });
  });
  it("deduplicates by skillName across agents, keeping the first registration", async () => {
    const mainWorkspace = await workspace("main");
    const researchWorkspace = await workspace("research");
    const commands = listSkillCommandsForAgents({
      cfg: agentConfig({
        main: { workspace: mainWorkspace },
        research: { workspace: researchWorkspace },
      }),
    });
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });

  it("skips agents with missing workspaces gracefully", async () => {
    const validWorkspace = await workspace("research");
    const commands = listSkillCommandsForAgents({
      cfg: agentConfig({
        valid: { workspace: validWorkspace },
        broken: { workspace: path.join(validWorkspace, "nonexistent") },
      }),
      agentIds: ["valid", "broken"],
    });
    expect(commands.map((entry) => entry.skillName)).toContain("demo-skill");
  });
  it("inherits defaults while preserving session context and the admitted plugin generation", async () => {
    const sharedWorkspace = await workspace("shared-defaults");
    const pluginMetadataSnapshot = createEmptyPluginMetadataSnapshot(sharedWorkspace);
    const librarySelections = [
      { skillId: "library-guide", revision: "revision", name: "guide", ownerProfileId: "profile" },
    ];
    const sessionEntry = {
      execHost: "node" as const,
      execNode: "build-node",
      skillLibrarySelections: librarySelections,
    };

    const commands = listSkillCommandsForWorkspace({
      workspaceDir: sharedWorkspace,
      cfg: agentConfig({ alpha: { workspace: sharedWorkspace } }, ["alpha-skill"]),
      agentId: "alpha",
      pluginMetadataSnapshot,
      sessionEntry,
      sessionKey: "agent:alpha:main",
      execOverrides: { security: "allowlist" },
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["alpha-skill"]);
    expect(lastCommandBuildOptions?.pluginMetadataSnapshot).toBe(pluginMetadataSnapshot);
    expect(lastCommandBuildOptions?.librarySelections).toBe(librarySelections);
    expect(resolveNodeExecEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry,
        sessionKey: "agent:alpha:main",
        execOverrides: { security: "allowlist" },
      }),
    );
  });
});
