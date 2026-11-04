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
  it("M1: contributes authoring and undo guidance only when Workshop is available", () => {
    const enabled = buildAgentSystemPrompt({
      workspaceDir: "/isolated/workspace",
      toolNames: ["read", "skill_workshop"],
    });
    const disabled = buildAgentSystemPrompt({
      workspaceDir: "/isolated/workspace",
      toolNames: ["read"],
    });
    expect(enabled).toContain("## Skill Workshop");
    expect(enabled).toContain(
      "When a learned skill you used was wrong or incomplete, view it and patch the misleading step.",
    );
    expect(enabled).toContain(
      "restore the named skill, or archive it if the notice says it was created.",
    );
    expect(enabled).toContain(
      "ordinary files: edit them directly when asked, never through skill_workshop.",
    );
    expect(disabled).not.toContain("## Skill Workshop");
    expect(disabled).not.toContain("restore the named skill");
  });
});
