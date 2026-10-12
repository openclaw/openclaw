import { render } from "lit";
import { describe, expect, it } from "vitest";
import { createIconTemplates } from "./icons-tools.ts";

describe("Lit icon data rendering", () => {
  it("keeps attribute text inside the SVG attribute instead of parsing it as markup", () => {
    const text = 'path & "quoted" <circle r="10">';
    const templates = createIconTemplates({
      sample: {
        attributes: { viewBox: "0 0 24 24" },
        children: [["path", { d: text }]],
      },
    });
    const container = document.createElement("div");
    render(templates.sample, container);
    const svg = container.querySelector("svg")!;
    expect(svg.children).toHaveLength(1);
    expect(svg.firstElementChild?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.firstElementChild?.getAttribute("d")).toBe(text);
  });
});
