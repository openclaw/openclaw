import { describe, expect, it } from "vitest";
import { buildSkillWorkshopPromptSection as buildCoreSkillWorkshopPromptSection } from "../agents/skill-workshop-prompt.js";
import { buildSkillWorkshopPromptSection } from "./agent-harness-runtime.js";

describe("agent-harness-runtime Workshop compatibility export", () => {
  it("re-exports the core builder directly without a forwarding wrapper (#188363)", () => {
    expect(buildSkillWorkshopPromptSection).toBe(buildCoreSkillWorkshopPromptSection);
    expect(buildSkillWorkshopPromptSection()).toEqual(buildCoreSkillWorkshopPromptSection());
  });
});
