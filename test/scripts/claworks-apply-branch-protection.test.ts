import { describe, expect, it } from "vitest";
import {
  buildBranchProtectionApiPath,
  formatProtectionPlan,
  loadBranchProtectionConfig,
} from "../../scripts/lib/claworks-apply-branch-protection.mjs";

describe("claworks apply branch protection", () => {
  it("loads claworks-main protection config", () => {
    const config = loadBranchProtectionConfig();
    expect(config.required_status_checks?.contexts).toContain("smoke");
    expect(config.allow_force_pushes).toBe(false);
  });

  it("builds gh api path", () => {
    expect(buildBranchProtectionApiPath({ owner: "acme", repo: "claworks", branch: "main" })).toBe(
      "/repos/acme/claworks/branches/main/protection",
    );
  });

  it("formats dry-run plan", () => {
    const config = loadBranchProtectionConfig();
    const plan = formatProtectionPlan({
      owner: "acme",
      repo: "claworks",
      branch: "main",
      config,
    });
    expect(plan).toContain("acme/claworks");
    expect(plan).toContain("smoke");
  });
});
