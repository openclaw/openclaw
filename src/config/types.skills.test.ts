import { describe, expect, it } from "vitest";
import type { SkillsLoadConfig } from "./types.skills.js";

describe("SkillsLoadConfig", () => {
  it("accepts index loading fields", () => {
    const cfg: SkillsLoadConfig = {
      indexFileName: "skills-index.json",
      indexFirst: true,
      strictIndex: true,
    };

    expect(cfg.indexFileName).toBe("skills-index.json");
    expect(cfg.indexFirst).toBe(true);
    expect(cfg.strictIndex).toBe(true);
  });
});
