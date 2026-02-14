import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Avoid importing/parsing the full skills loader + user home skills during unit tests.
vi.mock("@mariozechner/pi-coding-agent", () => ({
  formatSkillsForPrompt: () => "",
  loadSkillsFromDir: ({ dir, source }: { dir: string; source: string }) => {
    try {
      const entries = fsSync.readdirSync(dir, { withFileTypes: true });
      const skills = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => {
          const baseDir = path.join(dir, entry.name);
          const filePath = path.join(baseDir, "SKILL.md");
          if (!fsSync.existsSync(filePath)) {
            return null;
          }
          let raw = "";
          try {
            raw = fsSync.readFileSync(filePath, "utf-8");
          } catch {
            return null;
          }
          const nameMatch = raw.match(/^\s*name:\s*(.+)\s*$/m);
          const descriptionMatch = raw.match(/^\s*description:\s*(.+)\s*$/m);
          const name = (nameMatch?.[1] ?? entry.name).trim();
          const description = (descriptionMatch?.[1] ?? "").trim();
          return { name, description, source, filePath, baseDir };
        })
        .filter(Boolean);
      return { skills };
    } catch {
      return { skills: [] };
    }
  },
}));

// Avoid importing the full chat command registry for reserved-name calculation.
vi.mock("./commands-registry.js", () => ({
  listChatCommands: () => [],
}));

let listSkillCommandsForAgents: typeof import("./skill-commands.js").listSkillCommandsForAgents;
let resolveSkillCommandInvocation: typeof import("./skill-commands.js").resolveSkillCommandInvocation;

beforeAll(async () => {
  ({ listSkillCommandsForAgents, resolveSkillCommandInvocation } =
    await import("./skill-commands.js"));
});

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
    expect(names).toContain("demo_skill_2");
    expect(names).toContain("extra_skill");
  });
});
