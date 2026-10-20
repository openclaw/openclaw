import { expect, it } from "vitest";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

it("records successful discovered skill reads with the original sandbox provenance", async () => {
  const skillFile = "/host/skills/guide/SKILL.md";
  const readPath = "/sandbox/skills/guide/SKILL.md";
  const skill = createCanonicalFixtureSkill({
    name: "guide",
    description: "Guide",
    filePath: readPath,
    baseDir: "/sandbox/skills/guide",
    source: "workspace",
  });
  const tools = createInstalledSkillTools([
    {
      name: skill.name,
      description: skill.description,
      location: readPath,
      source: { filePath: readPath, readContent: "Whole instructions" },
    },
  ]);
  const runId = "installed-skill-usage";
  const tool = wrapToolWithBeforeToolCallHook(tools[1]!, {
    runId,
    agentId: "main",
    workspaceDir: "/sandbox",
    skillsSnapshot: {
      prompt: "",
      skills: [{ name: "guide" }],
      resolvedSkills: [],
      discoverySkills: [skill],
    },
    skillUsagePaths: [{ skillName: "guide", skillSource: "workspace", skillFile, readPath }],
    loopDetection: { enabled: false },
  });
  await expect(tool.execute("invalid", { name: "unknown" })).rejects.toThrow();
  expect(consumeRunSkillUsage(runId)).toEqual([]);
  await tool.execute("read-guide", { name: "guide" });
  expect(consumeRunSkillUsage(runId)).toEqual([
    { name: "guide", source: "workspace", activation: "read", skillFile },
  ]);
});
