import { describe, expect, it } from "vitest";
import { collectMcpAppStyleVariables } from "./mcp-app-theme.ts";

describe("collectMcpAppStyleVariables", () => {
  it("publishes trimmed, non-empty values", ({ onTestFinished }) => {
    const root = document.documentElement;
    const previousStyle = root.getAttribute("style");
    onTestFinished(() => {
      if (previousStyle === null) {
        root.removeAttribute("style");
      } else {
        root.setAttribute("style", previousStyle);
      }
    });
    root.style.setProperty("--card", "  #161920  ");
    root.style.setProperty("--bg", "#0e1015");
    const variables = collectMcpAppStyleVariables();

    // Values cross into a separate origin, where a Control UI token name would
    // have nothing to resolve against. Browsers substitute nested var()
    // references when computing a custom property, which is what makes the
    // published values self-contained; jsdom does not implement that
    // substitution, so the guarantee is verified in a browser rather than here.
    expect(variables["--color-background-primary"]).toBe("#161920");
    expect(
      Object.values(variables).every(
        (value) => typeof value === "string" && value === value.trim(),
      ),
    ).toBe(true);
  });
});
