import { describe, expect, it } from "vitest";
import { buildCopilotModelDefinition, getDefaultCopilotModelIds } from "./github-copilot-models.js";

describe("github-copilot-models", () => {
  it("includes gpt-5.3-codex in default model ids", () => {
    expect(getDefaultCopilotModelIds()).toContain("gpt-5.3-codex");
  });

  it("enables reasoning for codex models", () => {
    expect(buildCopilotModelDefinition("gpt-5.3-codex").reasoning).toBe(true);
    expect(buildCopilotModelDefinition("gpt-5.2-codex").reasoning).toBe(true);
  });

  it("keeps non-codex models without reasoning", () => {
    expect(buildCopilotModelDefinition("gpt-4o").reasoning).toBe(false);
  });
});
