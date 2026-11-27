import { describe, expect, it } from "vitest";
import { buildUiPresentationPrompt } from "./ui-presentation-prompt.js";

describe("UI presentation prompt", () => {
  it.each([undefined, "screen"])(
    "guides portal delivery using only the exposed screen capability (%s)",
    (screenToolName) => {
      const prompt = buildUiPresentationPrompt({ portalToolName: "portal", screenToolName });
      if (screenToolName) {
        expect(prompt).toContain("Control UI panels: `screen`");
      } else {
        expect(prompt).not.toContain("portal_show");
        expect(prompt).not.toContain("browser_show");
        expect(prompt).toContain("No `screen` this turn");
        expect(prompt).toContain("Control UI → Portals");
      }
    },
  );

  it("keeps the panel selection trigger before tool discovery", () => {
    const prompt = buildUiPresentationPrompt({ screenToolName: "screen" });
    expect(prompt).toContain("Control UI panels: `screen`");
    expect(prompt).toContain('clarify intended content for a generic "side panel"');
  });
});
