/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { icons } from "./icons.ts";

describe("retained Lit icon callers", () => {
  it("keeps reusable registry values", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    render(icons.copy, first);
    render(icons.copy, second);
    expect(first.querySelector("svg")).not.toBe(second.querySelector("svg"));
    expect(first.querySelector("rect")?.getAttribute("width")).toBe("14");
  });
});
