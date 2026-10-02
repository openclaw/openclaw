import { describe, expect, it } from "vitest";
import { formatSkillsForPromptCore } from "../skills/loading/skill-contract.js";
import { prepareSkillsForPrompt } from "../skills/loading/skill-prompt-limits.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const demo = createFixtureSkillEntry("demo").skill;
const unlistedPrompts = [
  { label: "empty prompt", skillsPrompt: "" },
  {
    label: "zero-entry budget notice",
    skillsPrompt: prepareSkillsForPrompt({ skills: [demo], maxSkillsInPrompt: 0 }).prompt,
  },
  {
    label: "remote note only",
    skillsPrompt: prepareSkillsForPrompt({
      skills: [],
      remoteNote: "Remote skill host is unavailable.",
    }).prompt,
  },
  {
    label: "empty catalog after filtering",
    skillsPrompt: "<available_skills>\n</available_skills>",
  },
];

describe("installed skill prompt guidance", () => {
  it.each([false, true])("uses Code Mode skill access only when admitted (%s)", (admitted) => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      codeModeActive: true,
      toolNames: ["exec"],
      capabilityToolNames: admitted ? ["skills_search", "skills_read"] : ["read"],
      skillsPrompt: formatSkillsForPromptCore([demo]),
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

  describe.each([false, true])("without listed entries (Code Mode: %s)", (codeModeActive) => {
    it.each(unlistedPrompts)("guides discovery with $label", ({ skillsPrompt }) => {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        codeModeActive,
        toolNames: codeModeActive ? ["exec"] : ["skills_search", "skills_read"],
        capabilityToolNames: ["skills_search", "skills_read"],
        skillsPrompt,
      });
      expect(prompt).toContain(codeModeActive ? "skills.search(query)" : "skills_search");
      expect(prompt).toContain(codeModeActive ? 'skills.read("<name>")' : "skills_read");
      expect(prompt).not.toContain("Scan <available_skills>");
      expect(prompt).not.toContain("use a listed match");
      const denied = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        codeModeActive,
        toolNames: codeModeActive ? ["exec"] : ["read"],
        capabilityToolNames: ["read"],
        skillsPrompt,
      });
      expect(denied).not.toContain("skills_search");
      expect(denied).not.toContain("skills.search(");
      expect(denied).not.toContain("Scan <available_skills>");
      expect(denied).not.toContain("read exact <location>");
      if (skillsPrompt) {
        expect(prompt).toContain(skillsPrompt);
        expect(denied).toContain(skillsPrompt);
      } else {
        expect(denied).not.toContain("## Skills");
      }
    });
  });
});
