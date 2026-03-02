import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Avoid importing the full chat command registry for reserved-name calculation.
vi.mock("./commands-registry.js", () => ({
  listChatCommands: () => [],
}));

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: () => ({}),
}));

// Avoid filesystem-driven skill scanning for these unit tests; we only need command naming semantics.
vi.mock("../agents/skills.js", () => {
  function resolveUniqueName(base: string, used: Set<string>): string {
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
    return [];
  }

  return {
    buildWorkspaceSkillCommandSpecs: (
      workspaceDir: string,
      opts?: { reservedNames?: Set<string>; skillFilter?: string[] },
    ) => {
      const used = new Set<string>();
      for (const reserved of opts?.reservedNames ?? []) {
        used.add(String(reserved).toLowerCase());
      }
      const filter = opts?.skillFilter;
      const entries =
        filter === undefined
          ? resolveWorkspaceSkills(workspaceDir)
          : resolveWorkspaceSkills(workspaceDir).filter((entry) =>
              filter.some((skillName) => skillName === entry.skillName),
            );

      return entries.map((entry) => {
        const base = entry.skillName.replace(/-/g, "_");
        const name = resolveUniqueName(base, used);
        return { name, skillName: entry.skillName, description: entry.description };
      });
    },
  };
});

let listSkillCommandsForAllAgents: typeof import("./skill-commands.js").listSkillCommandsForAllAgents;
let listSkillCommandsForAgentIds: typeof import("./skill-commands.js").listSkillCommandsForAgentIds;
let resolveSkillCommandInvocation: typeof import("./skill-commands.js").resolveSkillCommandInvocation;

beforeAll(async () => {
  ({ listSkillCommandsForAllAgents, listSkillCommandsForAgentIds, resolveSkillCommandInvocation } =
    await import("./skill-commands.js"));
});

describe("resolveSkillCommandInvocation", () => {
  it("matches skill commands and parses args", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/demo_skill do the thing",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.skillName).toBe("demo-skill");
    expect(invocation?.args).toBe("do the thing");
  });

  it("supports /skill with name argument", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo_skill do the thing",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBe("do the thing");
  });

  it("normalizes /skill lookup names", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo-skill",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBeUndefined();
  });

  it("returns null for unknown commands", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/unknown arg",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation).toBeNull();
  });
});

describe("listSkillCommandsForAllAgents/listSkillCommandsForAgentIds", () => {
  it("merges command names across agents and de-duplicates", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-"));
    const mainWorkspace = path.join(baseDir, "main");
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAllAgents({
      cfg: {
        agents: {
          list: [
            { id: "main", workspace: mainWorkspace },
            { id: "research", workspace: researchWorkspace },
          ],
        },
      },
    });
    const names = commands.map((entry) => entry.name);
    expect(names).toContain("demo_skill");
    expect(names).toContain("demo_skill_2");
    expect(names).toContain("extra_skill");
  });

  it("applies per-agent skills allowlist when listing commands", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-filter-"));
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgentIds({
      cfg: {
        agents: {
          list: [{ id: "research", workspace: researchWorkspace, skills: ["extra-skill"] }],
        },
      },
      agentIds: ["research"],
    });

    expect(commands.map((entry) => entry.name)).toEqual(["extra_skill"]);
    expect(commands.map((entry) => entry.skillName)).toEqual(["extra-skill"]);
  });

  it("prevents cross-agent skill leakage when each agent has a skills allowlist", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-leak-"));
    const mainWorkspace = path.join(baseDir, "main");
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgentIds({
      cfg: {
        agents: {
          list: [
            { id: "main", workspace: mainWorkspace, skills: ["demo-skill"] },
            { id: "research", workspace: researchWorkspace, skills: ["extra-skill"] },
          ],
        },
      },
      agentIds: ["main", "research"],
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });

  it("merges allowlists for agents that share one workspace", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-shared-"));
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgentIds({
      cfg: {
        agents: {
          list: [
            { id: "main", workspace: sharedWorkspace, skills: ["demo-skill"] },
            { id: "research", workspace: sharedWorkspace, skills: ["extra-skill"] },
          ],
        },
      },
      agentIds: ["main", "research"],
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });
});
