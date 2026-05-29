import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import {
  buildSkillIndex,
  isSkillPromptVisible,
  isSkillRuntimeVisible,
  isSkillUserInvocable,
  normalizeSkillIndexName,
} from "./skill-index.js";

describe("skill index", () => {
  it("normalizes skill names for case-insensitive separator-tolerant lookup", () => {
    expect(normalizeSkillIndexName(" Excel_XLSX/demo ")).toBe("excel-xlsx-demo");
    expect(normalizeSkillIndexName("Excel   XLSX")).toBe("excel-xlsx");
    expect(normalizeSkillIndexName("@@")).toBe("");
  });

  it("indexes entries by exact and normalized name without changing input order", () => {
    const entries = [
      createEntry("Excel XLSX", { skillKey: "excel_xlsx" }),
      createEntry("GitHub Review"),
    ];

    const index = buildSkillIndex(entries);

    expect(index.entries.map((entry) => entry.name)).toEqual(["Excel XLSX", "GitHub Review"]);
    expect(index.byName.get("Excel XLSX")?.entry).toBe(entries[0]);
    expect(index.byNormalizedName.get("excel-xlsx")?.map((entry) => entry.name)).toEqual([
      "Excel XLSX",
    ]);
    expect(index.byNormalizedName.get("github-review")?.map((entry) => entry.name)).toEqual([
      "GitHub Review",
    ]);
  });

  it("keeps ambiguous normalized names as multiple index entries", () => {
    const entries = [
      createEntry("Excel/XLSX", { skillKey: "excel-slash" }),
      createEntry("Excel_XLSX", { skillKey: "excel-underscore" }),
    ];

    const index = buildSkillIndex(entries);

    expect(index.byNormalizedName.get("excel-xlsx")?.map((entry) => entry.name)).toEqual([
      "Excel/XLSX",
      "Excel_XLSX",
    ]);
  });

  it("centralizes runtime, prompt, and command exposure policy", () => {
    const runtimeHidden = createEntry("runtime-hidden", {
      exposure: {
        includeInRuntimeRegistry: false,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
    });
    const promptHidden = createEntry("prompt-hidden", {
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: false,
        userInvocable: true,
      },
    });
    const commandHidden = createEntry("command-hidden", {
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: false,
      },
    });
    const legacyPromptHidden = createEntry("legacy-prompt-hidden", {
      invocation: { disableModelInvocation: true, userInvocable: true },
    });

    const index = buildSkillIndex([runtimeHidden, promptHidden, commandHidden, legacyPromptHidden]);

    expect(index.runtimeEntries.map((entry) => entry.skill.name)).toEqual([
      "prompt-hidden",
      "command-hidden",
      "legacy-prompt-hidden",
    ]);
    expect(index.promptVisibleEntries.map((entry) => entry.skill.name)).toEqual([
      "runtime-hidden",
      "command-hidden",
    ]);
    expect(index.userInvocableEntries.map((entry) => entry.skill.name)).toEqual([
      "runtime-hidden",
      "prompt-hidden",
      "legacy-prompt-hidden",
    ]);
    expect(isSkillRuntimeVisible(runtimeHidden)).toBe(false);
    expect(isSkillPromptVisible(legacyPromptHidden)).toBe(false);
    expect(isSkillUserInvocable(commandHidden)).toBe(false);
  });

  it("records source, bundled state, skill key, and agent filter state", () => {
    const bundled = createEntry("bundle", { source: "openclaw-bundled" });
    const unknownBundled = createEntry("unknown-bundle", { source: "unknown" });
    const workspace = createEntry("workspace", {
      source: "openclaw-workspace",
      skillKey: "workspace-key",
    });

    const index = buildSkillIndex([bundled, unknownBundled, workspace], {
      bundledNames: new Set(["unknown-bundle"]),
      agentSkillFilter: ["workspace"],
    });

    expect(index.byName.get("bundle")).toMatchObject({
      source: "openclaw-bundled",
      bundled: true,
      agentAllowed: false,
    });
    expect(index.byName.get("unknown-bundle")).toMatchObject({
      source: "unknown",
      bundled: true,
      agentAllowed: false,
    });
    expect(index.byName.get("workspace")).toMatchObject({
      source: "openclaw-workspace",
      bundled: false,
      skillKey: "workspace-key",
      agentAllowed: true,
    });
  });
});

function createEntry(
  name: string,
  opts?: {
    source?: string;
    skillKey?: string;
    exposure?: SkillEntry["exposure"];
    invocation?: SkillEntry["invocation"];
  },
): SkillEntry {
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: `${name} description`,
      filePath: `/skills/${name}/SKILL.md`,
      baseDir: `/skills/${name}`,
      source: opts?.source ?? "openclaw-workspace",
    }),
    frontmatter: {},
    metadata: opts?.skillKey ? { skillKey: opts.skillKey } : undefined,
    invocation: opts?.invocation ?? {
      userInvocable: true,
      disableModelInvocation: false,
    },
    exposure: opts?.exposure,
  };
}
