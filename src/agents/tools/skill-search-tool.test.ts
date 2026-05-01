import { describe, expect, it } from "vitest";
import type { Skill } from "../skills/skill-contract.js";
import { createSkillSearchTool } from "./skill-search-tool.js";

function skill(name: string, description: string, filePath = `/skills/${name}/SKILL.md`): Skill {
  return { name, description, filePath } as Skill;
}

describe("skill_search tool", () => {
  it("searches resolved skill names and descriptions only", async () => {
    const tool = createSkillSearchTool({
      resolvedSkills: [
        skill("memory-access", "Search and read persistent memory."),
        skill("web-markdown-navigator", "Navigate fetched markdown pages."),
        skill("dispatch-send", "Send a dispatch message."),
      ],
    });

    const result = await tool.execute("call", { query: "memory" });

    expect(result.details).toMatchObject({
      ok: true,
      query: "memory",
      count: 1,
      results: [
        {
          name: "memory-access",
          description: "Search and read persistent memory.",
          filePath: "/skills/memory-access/SKILL.md",
        },
      ],
    });
  });

  it("clamps limit to 1-20 and returns metadata without content", async () => {
    const resolvedSkills = Array.from({ length: 25 }, (_, index) =>
      skill(`skill-${index.toString().padStart(2, "0")}`, "common term"),
    );
    const tool = createSkillSearchTool({ resolvedSkills });

    const result = await tool.execute("call", { query: "common", limit: 50 });
    const details = result.details as { results: Array<Record<string, unknown>> };

    expect(details.results).toHaveLength(20);
    expect(details.results[0]).not.toHaveProperty("content");
  });
});
