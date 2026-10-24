import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import type { SkillCommandSpec } from "../types.js";

let listSkillCommandsForAgents: typeof import("./chat-commands.js").listSkillCommandsForAgents;
let listSkillCommandsForWorkspace: typeof import("./chat-commands.js").listSkillCommandsForWorkspace;
let expandExplicitSkillReferences: typeof import("./chat-commands.js").expandExplicitSkillReferences;
let resolveSkillCommandInvocation: typeof import("./chat-commands.js").resolveSkillCommandInvocation;
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

function skillFilter(cfg: OpenClawConfig | undefined, agentId: string | undefined) {
  const agent = agentId ? cfg?.agents?.entries?.[agentId] : undefined;
  return agent && Object.hasOwn(agent, "skills") ? agent.skills : cfg?.agents?.defaults?.skills;
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

async function createWorkspace(parentDir: string, name: string) {
  const workspace = path.join(parentDir, name);
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function resolveWorkspaceSkills(workspaceDir: string) {
  const fixtures: Record<string, [string, string][]> = {
    main: [["demo-skill", "Demo skill"]],
    research: [
      ["demo-skill", "Demo skill 2"],
      ["extra-skill", "Extra skill"],
    ],
    "shared-defaults": [
      ["alpha-skill", "Alpha skill"],
      ["beta-skill", "Beta skill"],
      ["hidden-skill", "Hidden skill"],
    ],
  };
  return (fixtures[path.basename(workspaceDir)] ?? []).map(([skillName, description]) => ({
    skillName,
    description,
  }));
}

function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: Parameters<typeof import("./command-specs.js").buildWorkspaceSkillCommandSpecs>[1],
) {
  lastCommandBuildOptions = opts;
  const used = new Set(Array.from(opts?.reservedNames ?? [], (name) => name.toLowerCase()));
  const filter = opts?.skillFilter ?? skillFilter(opts?.config, opts?.agentId);
  const entries = resolveWorkspaceSkills(workspaceDir).filter(
    (entry) => filter === undefined || filter.includes(entry.skillName),
  );

  return entries.map((entry) => {
    const base = entry.skillName.replace(/-/g, "_");
    const name = resolveUniqueSkillCommandName(base, used);
    return { name, skillName: entry.skillName, description: entry.description };
  });
}

// mock-isolation: Skill discovery uses an empty built-in registry to isolate skill filtering and naming.
vi.mock("../../auto-reply/commands-registry.data.js", () => ({
  listReservedChatSlashCommandNames: () => new Set<string>(),
}));

vi.mock("./command-specs.js", () => ({
  buildWorkspaceSkillCommandSpecs,
}));

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

// mock-isolation: Command discovery supplies synthetic agent filters independently of runtime agent configuration.
vi.mock("./agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: skillFilter,
}));

beforeAll(async () => {
  ({
    expandExplicitSkillReferences,
    listSkillCommandsForAgents,
    listSkillCommandsForWorkspace,
    resolveSkillCommandInvocation,
  } = await import("./chat-commands.js"));
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
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBe("first line\nsecond line");
  });
  it("treats only odd backslash runs as escaping a reference", () => {
    expect(
      expand(String.raw`Ignore \$demo_skill but resolve \\$demo_skill.`, [
        makeCommand("demo_skill", "demo-skill"),
        makeCommand("release_notes", "Release Notes", "Release notes"),
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
      makeCommand(
        `skill_${index + 1}`,
        `skill-${index + 1}-${"x".repeat(110)}`,
        `Skill ${index + 1}`,
      ),
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
    const baseDir = tempDirs.make("openclaw-skills-");
    const mainWorkspace = await createWorkspace(baseDir, "main");
    const researchWorkspace = await createWorkspace(baseDir, "research");

    const commands = listSkillCommandsForAgents({
      cfg: agentConfig({
        main: { workspace: mainWorkspace },
        research: { workspace: researchWorkspace },
      }),
    });
    const names = commands.map((entry) => entry.name);
    expect(names).toContain("demo_skill");
    expect(names).not.toContain("demo_skill_2");
    expect(names).toContain("extra_skill");
  });

  it("skips agents with missing workspaces gracefully", async () => {
    const baseDir = tempDirs.make("openclaw-skills-missing-");
    const validWorkspace = await createWorkspace(baseDir, "research");
    const missingWorkspace = path.join(baseDir, "nonexistent");

    const commands = listSkillCommandsForAgents({
      cfg: agentConfig({
        valid: { workspace: validWorkspace },
        broken: { workspace: missingWorkspace },
      }),
      agentIds: ["valid", "broken"],
    });

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map((entry) => entry.skillName)).toContain("demo-skill");
  });
  it("inherits defaults while preserving session context and the admitted plugin generation", async () => {
    const baseDir = tempDirs.make("openclaw-skills-workspace-defaults-");
    const sharedWorkspace = await createWorkspace(baseDir, "shared-defaults");

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
