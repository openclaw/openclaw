import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listSkillCommandsForAgents, resolveSkillCommandInvocation } from "./skill-commands.js";

async function writeSkill(params: {
  workspaceDir: string;
  dirName: string;
  name: string;
  description: string;
}) {
  const { workspaceDir, dirName, name, description } = params;
  const skillDir = path.join(workspaceDir, "skills", dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

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

describe("listSkillCommandsForAgents", () => {
  it("merges command names across agents and de-duplicates", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-"));
    const mainWorkspace = path.join(baseDir, "main");
    const researchWorkspace = path.join(baseDir, "research");
    await writeSkill({
      workspaceDir: mainWorkspace,
      dirName: "demo",
      name: "demo-skill",
      description: "Demo skill",
    });
    await writeSkill({
      workspaceDir: researchWorkspace,
      dirName: "demo2",
      name: "demo-skill",
      description: "Demo skill 2",
    });
    await writeSkill({
      workspaceDir: researchWorkspace,
      dirName: "extra",
      name: "extra-skill",
      description: "Extra skill",
    });

    const commands = listSkillCommandsForAgents({
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
    expect(names).not.toContain("demo_skill_2");
    expect(names).toContain("extra_skill");
  });

  it("deduplicates bundled skills across multiple agents", async () => {
    const originalBundledDir = process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
    try {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dedupe-"));

      // Create a mock bundled skills directory
      const bundledDir = path.join(tempDir, "bundled-skills");
      await fs.mkdir(bundledDir);
      await writeSkill({
        dir: bundledDir,
        dirName: "bundled-1",
        name: "bundled-skill",
        description: "A bundled skill",
      });

      // Create workspaces for two agents
      const agent1Workspace = path.join(tempDir, "agent1");
      const agent2Workspace = path.join(tempDir, "agent2");
      await fs.mkdir(path.join(agent1Workspace, "skills"), { recursive: true });
      await fs.mkdir(path.join(agent2Workspace, "skills"), { recursive: true });

      process.env.OPENCLAW_BUNDLED_SKILLS_DIR = bundledDir;

      const commands = listSkillCommandsForAgents({
        cfg: {
          agents: {
            list: [
              { id: "agent1", workspace: agent1Workspace },
              { id: "agent2", workspace: agent2Workspace },
            ],
          },
        },
      });

      const skillNames = commands.map((entry) => entry.skillName);
      const bundledSkillCommands = commands.filter((c) => c.skillName === "bundled-skill");
      expect(bundledSkillCommands.length).toBe(1);
      expect(skillNames).toContain("bundled-skill");
    } finally {
      process.env.OPENCLAW_BUNDLED_SKILLS_DIR = originalBundledDir;
    }
  });
});
