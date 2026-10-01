import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("installed skill prompt guidance", () => {
  it.each([false, true])("uses Code Mode skill access only when admitted (%s)", (admitted) => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      codeModeActive: true,
      toolNames: ["exec"],
      capabilityToolNames: admitted ? ["skills_search", "skills_read"] : ["read"],
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
    });
    if (admitted) {
      expect(prompt).toContain('`skills.read("<name>")`');
      expect(prompt).toContain("skills.search(query)");
      expect(prompt).not.toContain("read exact <location> with `read`");
    } else {
      expect(prompt).not.toContain("skills.read(");
      expect(prompt).not.toContain("skills.search(");
    }
  });

  it("advertises search only when the prepared tool surface supports it", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["skills_search", "skills_read"],
      skillsPrompt: "",
    });
    expect(prompt).toContain("skills_search");
    expect(prompt).toContain("skills_read");
    expect(prompt).toContain("directory is bounded");
    const denied = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt: "",
    });
    expect(denied).not.toContain("skills_search");
    expect(denied).not.toContain("## Skills");
  });
});
