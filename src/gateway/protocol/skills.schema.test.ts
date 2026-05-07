import { describe, it, expect } from "vitest";
import { validateSkillsInstallParams } from "./index.js";

describe("skills.install schema", () => {
  it("rejects dangerouslyForceUnsafeInstall in skills.install params", () => {
    const params = { name: "calendar", installId: "deps", dangerouslyForceUnsafeInstall: true };
    expect(validateSkillsInstallParams(params)).toBe(false);
  });

  it("accepts valid skills.install params without the flag", () => {
    const params = { name: "calendar", installId: "deps" };
    expect(validateSkillsInstallParams(params)).toBe(true);
  });
});
