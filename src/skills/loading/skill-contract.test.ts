// Skill contract tests cover full and compact catalog serialization.
import { formatSkillsForPrompt as upstreamFormatSkillsForPrompt } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import { makeSkill } from "../test-support/test-helpers.js";
import {
  compactSkillsPromptForContext,
  formatSkillsForPromptCore,
  limitSkillsPromptCatalog,
  type Skill,
  formatSkillsCompactForPrompt as formatSkillsCompact,
} from "./skill-contract.js";

describe("compactSkillsPromptForContext", () => {
  it("preserves nested entities and whole surrogate pairs while normalizing whitespace", () => {
    const prompt = `<available_skills><description> \t&amp;lt; \n&lt;tag&gt; ${"a".repeat(49)}😀${" tail".repeat(20)}</description></available_skills>`;

    expect(compactSkillsPromptForContext(prompt, 1)).toBe(
      `<available_skills><description>&amp;lt; &lt;tag&gt; ${"a".repeat(49)}...</description></available_skills>`,
    );
  });

  it.each(["&".repeat(50)])(
    "keeps the original when escaped projection is not strictly shorter: %s",
    (description) => {
      const prompt = `<available_skills><description>${description}</description></available_skills>`;
      expect(compactSkillsPromptForContext(prompt, 1)).toBe(prompt);
    },
  );

  it.each([-1])("keeps prompt bytes when the context budget is %s", (budget) => {
    const prompt = `<available_skills><description>  ${"long description ".repeat(30)}</description></available_skills>`;
    expect(compactSkillsPromptForContext(prompt, budget)).toBe(prompt);
  });
});

describe("limitSkillsPromptCatalog", () => {
  const prompt = formatSkillsForPromptCore(
    ["alpha", "beta", "gamma"].map((name) => makeSkill(name, `${name} skill`)),
  );

  it("keeps the first entries and the catalog frame", () => {
    const limited = limitSkillsPromptCatalog(prompt, 2);
    expect(limited).toContain("<name>alpha</name>");
    expect(limited).toContain("<name>beta</name>");
    expect(limited).not.toContain("<name>gamma</name>");
    expect(limited.trimEnd().endsWith("</available_skills>")).toBe(true);
  });

  it("renders no catalog for zero and leaves unlimited prompts unchanged", () => {
    expect(limitSkillsPromptCatalog(prompt, 0)).toBe("");
    expect(limitSkillsPromptCatalog(prompt, undefined)).toBe(prompt);
    expect(limitSkillsPromptCatalog(prompt, 3)).toBe(prompt);
  });
});

describe("formatSkillsCompact", () => {
  it("keeps the full-format XML output aligned with the upstream formatter for visible skills", () => {
    const skills = [
      makeSkill("notes", "Summarize notes", "/tmp/notes/SKILL.md"),
      { ...makeSkill("weather", "Get weather <data> & forecasts"), promptVersion: "sha256:abc123" },
    ];
    const out = formatSkillsForPromptCore(skills);
    expect(out).toBe(upstreamFormatSkillsForPrompt(skills));
    expect(out).not.toContain("<version>");
  });

  it("returns empty string for no skills", () => {
    expect(formatSkillsCompact([])).toBe("");
  });

  it("preserves location notes when compact descriptions are omitted", () => {
    const out = formatSkillsCompact(
      [
        {
          ...makeSkill("remote", "Remote skill"),
          locationNote: "Load with exec host=node node=node-1.",
        },
      ],
      { descriptionMaxChars: 0 },
    );

    expect(out).toContain("<location_note>Load with exec host=node node=node-1.</location_note>");
  });

  it("renders all passed skills without reapplying visibility policy", () => {
    const hidden: Skill = { ...makeSkill("hidden"), disableModelInvocation: true };
    const out = formatSkillsCompact([makeSkill("visible"), hidden]);
    expect(out).toContain("visible");
    expect(out).toContain("hidden");
  });
});
