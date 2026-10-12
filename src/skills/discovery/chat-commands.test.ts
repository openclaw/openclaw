import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";

let listSkillCommandsForAgents: typeof import("./chat-commands.js").listSkillCommandsForAgents;
let listSkillCommandsForWorkspace: typeof import("./chat-commands.js").listSkillCommandsForWorkspace;
let expandExplicitSkillReferences: typeof import("./chat-commands.js").expandExplicitSkillReferences;
let resolveSkillCommandInvocation: typeof import("./chat-commands.js").resolveSkillCommandInvocation;
let lastCommandBuildOptions:
  | { pluginMetadataSnapshot?: unknown; librarySelections?: unknown }
  | undefined;

function resolveSkillReferenceInvocations(
  params: Parameters<typeof expandExplicitSkillReferences>[0],
) {
  return expandExplicitSkillReferences(params).skills;
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

async function createMainAndResearchWorkspaces(prefix: string) {
  const baseDir = tempDirs.make(prefix);
  const mainWorkspace = await createWorkspace(baseDir, "main");
  const researchWorkspace = await createWorkspace(baseDir, "research");
  return { mainWorkspace, researchWorkspace };
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

function resolveWorkspaceSkills(
  workspaceDir: string,
): Array<{ skillName: string; description: string }> {
  const dirName = path.basename(workspaceDir);
  if (dirName === "main") {
    return [{ skillName: "demo-skill", description: "Demo skill" }];
  }
  if (dirName === "research") {
    return [
      { skillName: "demo-skill", description: "Demo skill 2" },
      { skillName: "extra-skill", description: "Extra skill" },
    ];
  }
  if (dirName === "shared-defaults") {
    return [
      { skillName: "alpha-skill", description: "Alpha skill" },
      { skillName: "beta-skill", description: "Beta skill" },
      { skillName: "hidden-skill", description: "Hidden skill" },
    ];
  }
  return [];
}

function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    reservedNames?: Set<string>;
    skillFilter?: string[];
    agentId?: string;
    pluginMetadataSnapshot?: unknown;
    librarySelections?: unknown;
    config?: {
      agents?: {
        defaults?: { skills?: string[] };
        entries?: Record<string, { skills?: string[] }>;
      };
    };
  },
) {
  lastCommandBuildOptions = opts;
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }
  const agentSkills = opts?.agentId ? opts.config?.agents?.entries?.[opts.agentId] : undefined;
  const filter =
    opts?.skillFilter ??
    (agentSkills && Object.hasOwn(agentSkills, "skills")
      ? agentSkills.skills
      : opts?.config?.agents?.defaults?.skills);
  const entries =
    filter === undefined
      ? resolveWorkspaceSkills(workspaceDir)
      : resolveWorkspaceSkills(workspaceDir).filter((entry) =>
          filter.some((skillName) => skillName === entry.skillName),
        );

  return entries.map((entry) => {
    const base = entry.skillName.replace(/-/g, "_");
    const name = resolveUniqueSkillCommandName(base, used);
    return { name, skillName: entry.skillName, description: entry.description };
  });
}

vi.mock("../../auto-reply/commands-registry.data.js", () => ({
  getChatCommands: () => [],
}));

vi.mock("./command-specs.js", () => ({
  buildWorkspaceSkillCommandSpecs,
}));

vi.mock("../runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({}),
}));

vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: resolveNodeExecEligibilityMock,
}));

vi.mock("./agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: (
    cfg: {
      agents?: {
        defaults?: { skills?: string[] };
        entries?: Record<string, { skills?: string[] }>;
      };
    },
    agentId: string,
  ) => {
    const agent = cfg.agents?.entries?.[agentId];
    if (agent && Object.hasOwn(agent, "skills")) {
      return agent.skills;
    }
    return cfg.agents?.defaults?.skills;
  },
}));

beforeAll(async () => {
  ({
    expandExplicitSkillReferences,
    listSkillCommandsForAgents,
    listSkillCommandsForWorkspace,
    resolveSkillCommandInvocation,
  } = await import("./chat-commands.js"));
});

afterAll(() => {
  tempDirs.cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  lastCommandBuildOptions = undefined;
  resolveNodeExecEligibilityMock.mockReturnValue({ canExec: false });
});

describe("resolveSkillCommandInvocation", () => {
  it("preserves multiline args for /skill invocations", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo_skill first line\nsecond line",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBe("first line\nsecond line");
  });

  it("preserves multiline args for direct skill slash invocations", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/demo_skill first line\nsecond line",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBe("first line\nsecond line");
  });
});

describe("resolveSkillReferenceInvocations", () => {
  const skillCommands = [
    { name: "demo_skill", skillName: "demo-skill", description: "Demo" },
    { name: "release_notes", skillName: "Release Notes", description: "Release notes" },
  ];

  it("treats only odd backslash runs as escaping a reference", () => {
    expect(
      resolveSkillReferenceInvocations({
        text: String.raw`Ignore \$demo_skill but resolve \\$demo_skill.`,
        skillCommands,
      }).map((command) => command.name),
    ).toEqual(["demo_skill"]);
  });
});

describe("expandExplicitSkillReferences", () => {
  it("renders a leading bundle command template and leaves dollar-like bundle text literal", () => {
    const bundleCommand = {
      name: "workflows_review",
      skillName: "workflows-review",
      description: "Review a workflow",
      promptTemplate: "Review this workflow.\n\nFocus on:\n$ARGUMENTS",
      sourceFilePath: "/tmp/plugin/commands/workflows-review.md",
    };
    expect(
      expandExplicitSkillReferences({
        text: "/workflows_review retries",
        skillCommands: [bundleCommand],
      }),
    ).toEqual({
      body: "Review this workflow.\n\nFocus on:\nretries",
      skills: [bundleCommand],
    });
    expect(
      expandExplicitSkillReferences({
        text: "Keep $workflows_review literal.",
        skillCommands: [bundleCommand],
      }),
    ).toEqual({ body: "Keep $workflows_review literal.", skills: [] });
  });

  it("leaves unknown leading slash commands byte-identical", () => {
    const text = "/compact with $demo_skill";
    expect(
      expandExplicitSkillReferences({
        text,
        skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
      }),
    ).toEqual({ body: text, skills: [] });
  });

  it.each([
    {
      label: "slash command",
      text: "/foo run it",
      available: { name: "foo", skillName: "foo?", description: "Allowed skill" },
      hidden: { name: "foo", skillName: "foo!", description: "Hidden skill" },
      allAvailableName: "foo_2",
    },
    {
      label: "dollar reference",
      text: "Run it with $foo_bar.",
      available: { name: "foo_bar", skillName: "foo-bar", description: "Allowed skill" },
      hidden: { name: "foo_bar", skillName: "foo:bar", description: "Hidden skill" },
      allAvailableName: "foo_bar_2",
    },
  ])(
    "prefers an available $label when hidden skill names collide",
    ({ text, available, hidden, allAvailableName }) => {
      expect(
        expandExplicitSkillReferences({
          text,
          skillCommands: [available],
          allSkillCommands: [hidden, { ...available, name: allAvailableName }],
        }),
      ).toEqual({
        body: [
          "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
          `- ${available.skillName}`,
          "",
          "User request:",
          text,
        ].join("\n"),
        skills: [available],
      });
    },
  );

  it("rejects a rendered skill reference that exceeds its prompt budget", () => {
    const text = "/demo_skill";
    expect(
      expandExplicitSkillReferences({
        text,
        skillCommands: [
          {
            name: "demo_skill",
            skillName: "demo-skill",
            description: "Demo",
            modelVisible: false,
            skillFile: `/tmp/${"nested/".repeat(80)}SKILL.md`,
          },
        ],
      }),
    ).toEqual({
      body: text,
      error:
        "Skill reference metadata is too long. Keep each rendered reference at 512 characters or less.",
      skills: [],
    });
  });

  it("rejects a combined reference prefix that exceeds its prompt budget", () => {
    const skillCommands = Array.from({ length: 8 }, (_, index) => ({
      name: `skill_${index + 1}`,
      skillName: `skill-${index + 1}-${"x".repeat(110)}`,
      description: `Skill ${index + 1}`,
    }));
    const text = skillCommands.map((skill) => `$${skill.name}`).join(" ");
    expect(expandExplicitSkillReferences({ text, skillCommands })).toEqual({
      body: text,
      error:
        "Combined skill reference metadata is too long. Use fewer or shorter skill references.",
      skills: [],
    });
  });
});

describe("listSkillCommandsForAgents", () => {
  it("deduplicates by skillName across agents, keeping the first registration", async () => {
    const { mainWorkspace, researchWorkspace } =
      await createMainAndResearchWorkspaces("openclaw-skills-");

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          entries: {
            main: { workspace: mainWorkspace },
            research: { workspace: researchWorkspace },
          },
        },
      },
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
      cfg: {
        agents: {
          entries: {
            valid: { workspace: validWorkspace },
            broken: { workspace: missingWorkspace },
          },
        },
      },
      agentIds: ["valid", "broken"],
    });

    // The valid agent's skills should still be listed despite the broken one.
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map((entry) => entry.skillName)).toContain("demo-skill");
  });
});

describe("listSkillCommandsForWorkspace", () => {
  it("inherits defaults while preserving session context and the admitted plugin generation", async () => {
    const baseDir = tempDirs.make("openclaw-skills-workspace-defaults-");
    const sharedWorkspace = await createWorkspace(baseDir, "shared-defaults");

    const pluginMetadataSnapshot = createEmptyPluginMetadataSnapshot(sharedWorkspace);
    const librarySelections = [
      { skillId: "library-guide", revision: "revision", name: "guide", ownerProfileId: "profile" },
    ];

    const commands = listSkillCommandsForWorkspace({
      workspaceDir: sharedWorkspace,
      cfg: {
        agents: {
          defaults: {
            skills: ["alpha-skill"],
          },
          entries: { alpha: { workspace: sharedWorkspace } },
        },
      },
      agentId: "alpha",
      pluginMetadataSnapshot,
      sessionEntry: {
        execHost: "node",
        execNode: "build-node",
        skillLibrarySelections: librarySelections,
      },
      sessionKey: "agent:alpha:main",
      execOverrides: { security: "allowlist" },
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["alpha-skill"]);
    expect(lastCommandBuildOptions?.pluginMetadataSnapshot).toBe(pluginMetadataSnapshot);
    expect(lastCommandBuildOptions?.librarySelections).toBe(librarySelections);
    expect(resolveNodeExecEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: {
          execHost: "node",
          execNode: "build-node",
          skillLibrarySelections: librarySelections,
        },
        sessionKey: "agent:alpha:main",
        execOverrides: { security: "allowlist" },
      }),
    );
  });
});
