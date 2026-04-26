import { describe, expect, it } from "vitest";
import {
  createMissionControlActionSinkPolicyFixture,
  parseActionSinkPolicyConfig,
} from "./action-sink-policy-config.js";

describe("action sink policy config", () => {
  it("parses minimal/default config", () => {
    expect(parseActionSinkPolicyConfig({}).defaultMode).toBe("shadow");
  });

  it("rejects malformed modes", () => {
    expect(() => parseActionSinkPolicyConfig({ defaultMode: "warn" })).toThrow(/shadow/);
  });

  it("adds Mission Control fixture paths without kernel constants", () => {
    const fixture = createMissionControlActionSinkPolicyFixture();
    expect(fixture.protectedRoots).toContain("/Users/admin/Projects/mission-control-production");
    expect(fixture.assignedWorktrees[0]?.worktreeRoot).toBe("/Users/admin/Projects/mc-workers/");
  });
});
