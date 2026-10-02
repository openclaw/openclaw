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

  it.each([false, true])("guides discovery without a prompt directory (%s)", (codeModeActive) => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      codeModeActive,
      toolNames: codeModeActive ? ["exec"] : ["skills_search", "skills_read"],
      capabilityToolNames: ["skills_search", "skills_read"],
      skillsPrompt: "",
    });
    expect(prompt).toContain(codeModeActive ? "skills.search(query)" : "skills_search");
    expect(prompt).toContain(codeModeActive ? 'skills.read("<name>")' : "skills_read");
    expect(prompt).not.toContain("<available_skills>");
    const denied = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
      skillsPrompt: "",
    });
    expect(denied).not.toContain("skills_search");
    expect(denied).not.toContain("## Skills");
  });
});
