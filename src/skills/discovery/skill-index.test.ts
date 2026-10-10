// Skill discovery helpers preserve name matching and prompt/command exposure.
import { describe, expect, it } from "vitest";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import {
  isSkillPromptVisible,
  isSkillUserInvocable,
  normalizeSkillIndexName,
} from "./skill-index.js";

describe("skill index", () => {
  it("normalizes skill names for case-insensitive separator-tolerant lookup", () => {
    expect(normalizeSkillIndexName(" Excel_XLSX/demo ")).toBe("excel-xlsx-demo");
    expect(normalizeSkillIndexName("Excel   XLSX")).toBe("excel-xlsx");
    expect(normalizeSkillIndexName("@@")).toBe("");
  });

  it("keeps prompt and command exposure independent of runtime visibility", () => {
    const runtimeHidden = createFixtureSkillEntry("runtime-hidden", {
      exposure: {
        includeInRuntimeRegistry: false,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
    });
    const promptHidden = createFixtureSkillEntry("prompt-hidden", {
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: false,
        userInvocable: true,
      },
    });
    const commandHidden = createFixtureSkillEntry("command-hidden", {
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: false,
      },
    });
    const legacyPromptHidden = createFixtureSkillEntry("legacy-prompt-hidden", {
      invocation: { disableModelInvocation: true, userInvocable: true },
    });

    const entries = [runtimeHidden, promptHidden, commandHidden, legacyPromptHidden];
    expect(entries.filter(isSkillPromptVisible)).toEqual([runtimeHidden, commandHidden]);
    expect(entries.filter(isSkillUserInvocable)).toEqual([
      runtimeHidden,
      promptHidden,
      legacyPromptHidden,
    ]);
  });
});
