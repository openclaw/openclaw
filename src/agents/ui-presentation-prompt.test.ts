import { describe, expect, it } from "vitest";
import { buildUiPresentationPrompt } from "./ui-presentation-prompt.js";

describe("UI presentation prompt", () => {
  it.each([undefined, "screen"])(
    "guides portal delivery using only the exposed screen capability (%s)",
    (screenToolName) => {
      const prompt = buildUiPresentationPrompt({ portalToolName: "portal", screenToolName });
      expect(prompt).toContain("target environment");
      expect(prompt).toContain("`environmentId` if attached");
      expect(prompt).toContain("loopback-only is Gateway-local");
      expect(prompt).toContain("non-loopback != remote-access proof");
      expect(prompt).toContain("worker/Gateway fetch or panel dispatch != delivery proof");
      expect(prompt).toContain("requesting viewer");
      expect(prompt).toContain("blocked/unverified");
      if (screenToolName) {
        expect(prompt).toContain('screen(action="portal_show", portalId="<id>")');
      } else {
        expect(prompt).not.toContain("portal_show");
        expect(prompt).not.toContain("browser_show");
        expect(prompt).toContain("No `screen` tool this turn");
        expect(prompt).toContain("Control UI → Portals");
      }
    },
  );

  it("distinguishes app previews and ambiguous side panels from the agent Browser panel", () => {
    const prompt = buildUiPresentationPrompt({ screenToolName: "screen" });
    expect(prompt).toContain('screen(action="browser_show")');
    expect(prompt).toContain("for agent Browser only");
    expect(prompt).toContain("app previews use `portal_show(portalId)`");
    expect(prompt).toContain('generic "side panel" needs intended content');
  });
});
