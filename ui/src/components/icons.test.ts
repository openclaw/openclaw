/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { keyboardIconShapes, strokeIcon } from "./icons-tools.ts";
import { icons } from "./icons.ts";

describe("retained Lit icon callers", () => {
  it("keeps reusable registry values and custom stroked keyboard fragments", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    render(icons.copy, first);
    render(icons.copy, second);
    expect(first.querySelector("svg")).not.toBe(second.querySelector("svg"));
    expect(first.querySelector("rect")?.getAttribute("width")).toBe("14");
    render(strokeIcon(keyboardIconShapes["⌘"], "width: 1em"), first);
    expect(first.querySelectorAll("svg")).toHaveLength(1);
    expect(first.querySelector("svg")?.style.width).toBe("1em");
    expect(first.querySelector("path")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(first.querySelector("svg")?.getAttribute("stroke-width")).toBe("2");
  });
});
