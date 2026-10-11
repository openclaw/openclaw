import { describe, expect, it } from "vitest";
import { collectMcpAppStyleVariables } from "./mcp-app-theme.ts";

function rootWithTokens(tokens: Record<string, string>): HTMLElement {
  const element = document.createElement("div");
  for (const [name, value] of Object.entries(tokens)) {
    element.style.setProperty(name, value);
  }
  document.body.append(element);
  return element;
}

describe("collectMcpAppStyleVariables", () => {
  it("publishes trimmed, non-empty values", () => {
    const variables = collectMcpAppStyleVariables(
      rootWithTokens({ "--card": "  #161920  ", "--bg": "#0e1015" }),
    );

    // Values cross into a separate origin, where a Control UI token name would
    // have nothing to resolve against. Browsers substitute nested var()
    // references when computing a custom property, which is what makes the
    // published values self-contained; jsdom does not implement that
    // substitution, so the guarantee is verified in a browser rather than here.
    expect(variables?.["--color-background-primary"]).toBe("#161920");
    expect(
      Object.values(variables ?? {}).every(
        (value) => typeof value === "string" && value === value.trim(),
      ),
    ).toBe(true);
  });
});
