import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateWorkshopPluginForTest } from "../skills/test-support/workshop-plugin.test-support.js";
import { buildAgentHarnessBasePrompt } from "./system-prompt-harness-base.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const toolNames = ["exec", "openclaw", "sessions_spawn", "image_generate", "skill_workshop"];

// The skill-workshop plugin registers the Workshop section as its tool's prompt guidance.
let resetPlugins: (() => void) | undefined;
beforeAll(async () => {
  resetPlugins = (await activateWorkshopPluginForTest()).reset;
});
afterAll(() => resetPlugins?.());

function sectionBody(prompt: string, heading: string) {
  const start = prompt.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = prompt.indexOf("\n## ", start + heading.length);
  return prompt.slice(start, end < 0 ? undefined : end).trim();
}

describe("buildAgentHarnessBasePrompt", () => {
  it("renders the regular prompt's policy sections byte for byte, without turn facts", () => {
    const regular = buildAgentSystemPrompt({ workspaceDir: "/work", toolNames });
    const base = buildAgentHarnessBasePrompt({ toolNames });

    for (const heading of [
      "## Execution Bias",
      "## Promised Work",
      "## Tool Call Style",
      "## Care",
      "## OpenClaw Control",
      "## Skill Workshop",
    ]) {
      expect(sectionBody(base, heading)).toBe(sectionBody(regular, heading));
    }
    // These change between turns and would invalidate the pinned bytes.
    for (const turnFact of ["## Workspace", "## Runtime\n", "## Skills", "Runtime: agent="]) {
      expect(base).not.toContain(turnFact);
    }
  });

  it("renders provider policy and gates capability guidance on the tool set", () => {
    const withTools = buildAgentHarnessBasePrompt({
      toolNames,
      promptContribution: {
        dynamicSuffix: "turn-only suffix",
        sectionOverrides: { interaction_style: "## Interaction Style\nProvider voice." },
      },
    });
    expect(withTools).toContain("Provider voice.");
    expect(withTools).toContain("`image_generate`");
    expect(withTools).not.toContain("turn-only suffix");

    expect(buildAgentHarnessBasePrompt({ toolNames: [] })).not.toContain("image_generate");
    // Minimal and none prompt modes stay lean.
    const minimal = buildAgentHarnessBasePrompt({ toolNames, promptMode: "minimal" });
    expect(minimal).not.toContain("## Execution Bias");
    expect(minimal).not.toContain("## Documentation");

    expect(buildAgentHarnessBasePrompt({ toolNames, promptMode: "none" })).toBe(
      "You are a personal assistant running inside OpenClaw.",
    );
  });
});
