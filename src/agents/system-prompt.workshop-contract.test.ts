import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateWorkshopPluginForTest } from "../skills/test-support/workshop-plugin.test-support.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

// The skill-workshop plugin registers the Workshop section as its tool's prompt guidance.
let resetPlugins: (() => void) | undefined;
beforeAll(async () => {
  resetPlugins = (await activateWorkshopPluginForTest()).reset;
});
afterAll(() => resetPlugins?.());

describe("Workshop system prompt availability", () => {
  it("contributes learned-skill maintenance triggers only when Workshop is available", () => {
    const enabled = buildAgentSystemPrompt({
      workspaceDir: "/isolated/workspace",
      toolNames: ["read", "skill_workshop"],
    });
    const disabled = buildAgentSystemPrompt({
      workspaceDir: "/isolated/workspace",
      toolNames: ["read"],
    });
    expect(enabled).toContain("## Skill Workshop");
    expect(enabled).toContain("wrong/incomplete learned skill");
    expect(enabled).toContain("hard multi-step work this user will repeat");
    expect(enabled).toContain("Patch/create with `skill_workshop`");
    expect(disabled).not.toContain("## Skill Workshop");
    expect(disabled).not.toContain("restore that skill");
  });
});
