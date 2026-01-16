import { describe, expect, it } from "vitest";
import { resolveSkillCommandInvocation } from "./skill-commands.js";

describe("resolveSkillCommandInvocation", () => {
  it("matches skill commands and parses args", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/demo_skill do the thing",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.skillName).toBe("demo-skill");
    expect(invocation?.args).toBe("do the thing");
  });

  it("returns null for unknown commands", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/unknown arg",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation).toBeNull();
  });
});
