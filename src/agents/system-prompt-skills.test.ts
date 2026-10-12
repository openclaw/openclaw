import { describe, expect, it } from "vitest";
import { formatSkillsForPromptCore } from "../skills/loading/skill-contract.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { buildSkillsSection } from "./system-prompt-skills.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const skillsPrompt = formatSkillsForPromptCore([createFixtureSkillEntry("demo").skill]);

describe("task-scoped skill discovery", () => {
  it.each([false, true])("uses name-based skills with Code Mode %s", (codeModeActive) => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      codeModeActive,
      toolNames: codeModeActive ? ["exec"] : ["skills_read", "skills_search"],
      capabilityToolNames: ["skills_read", "skills_search"],
      skillsPrompt,
    });
    expect(prompt).toContain("At the start of a new task, check <available_skills> once.");
    expect(prompt).toContain("Use a listed skill when the task matches it or the user names it.");
    expect(prompt).toContain("when the task likely needs a reusable workflow that is not listed.");
    expect(prompt).toContain(
      "Search or read again only when the task's scope changes or the user names a skill.",
    );
    expect(prompt).toContain(
      codeModeActive ? "`skills.search(query)` inside `exec`" : "`skills_search`",
    );
    expect(prompt).toContain("<name>demo</name>");
    expect(prompt).toContain("<description>");
    expect(prompt).not.toContain("<location>");
    expect(prompt).not.toContain("Read a skill's file at its listed location");
    expect(prompt).not.toContain("When a skill file references a relative path");
  });

  it.each([false, true])(
    "preserves the complete legacy section without read, search %s",
    (installedSkillSearch) => {
      expect(
        buildSkillsSection({ skillsPrompt, readToolName: "read", installedSkillSearch }),
      ).toEqual([
        "## Skills",
        "Scan <available_skills> for a matching workflow.",
        "Clear match: read exact <location> with `read`; obey.",
        ...(installedSkillSearch
          ? [
              "Before work involving files, specialized tools, or a reusable workflow, use a listed match or search with `skills_search` for an applicable skill. Read the best match before implementing the workflow yourself.",
              "Search by the task goal and distinctive terms. Simple conversation or a self-contained answer does not need a search. Search covers installed skills; it does not install skills.",
            ]
          : []),
        "Several: most specific. No relevant skill: read none.",
        "Up-front max one. Never invent paths.",
        "External writes: batch safely; no tight loops; honor 429/Retry-After.",
        skillsPrompt.trim(),
        "",
      ]);
    },
  );
});
