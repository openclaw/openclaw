import { describe, expect, it } from "vitest";
import { buildUiPresentationPrompt } from "./ui-presentation-prompt.js";

describe("UI presentation prompt", () => {
  it.each([undefined, "screen"])(
    "guides portal delivery using only the exposed screen capability (%s)",
    (screenToolName) => {
      const prompt = buildUiPresentationPrompt({ portalToolName: "portal", screenToolName });
      expect(prompt).toContain("correct environment");
      expect(prompt).toContain("environmentId for an attachment");
      expect(prompt).toContain("loopback-only is local to the Gateway host");
      expect(prompt).toContain("non-loopback is not proof of remote access");
      expect(prompt).toContain("worker/Gateway fetch or browser test is not delivery proof");
      expect(prompt).toContain("requesting viewer");
      expect(prompt).toContain("blocked or unverified");
      if (screenToolName) {
        expect(prompt).toContain('screen(action="portal_show", portalId="<returned id>")');
      } else {
        expect(prompt).not.toContain("portal_show");
        expect(prompt).not.toContain("browser_show");
        expect(prompt).toContain("No screen tool is exposed this turn");
        expect(prompt).toContain("Control UI → Portals");
      }
    },
  );

  it("distinguishes app previews and ambiguous side panels from the agent Browser panel", () => {
    const prompt = buildUiPresentationPrompt({ screenToolName: "screen" });
    expect(prompt).toContain("For the agent Browser panel specifically");
    expect(prompt).toContain('screen(action="browser_show")');
    expect(prompt).toContain(
      "For an app preview, use portal_show with its portalId, not browser_show",
    );
    expect(prompt).toContain('A generic "side panel" request needs the intended content');
  });
});
