import { describe, expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { toolIcons } from "./icons-tools.ts";

describe("tool icon registry", () => {
  it("renders independent SVG placements with the tool geometry", () => {
    const storedIcon = toolIcons.lightbulb;
    const first = mountSolid(() => <>{storedIcon()}</>);
    const second = mountSolid(() => <>{storedIcon()}</>);
    const firstSvg = first.container.querySelector("svg");
    const secondSvg = second.container.querySelector("svg");
    expect(firstSvg).not.toBeNull();
    expect(firstSvg).not.toBe(secondSvg);
    expect(firstSvg?.getAttribute("stroke")).toBe("currentColor");
    expect(firstSvg?.getAttribute("stroke-width")).toBe("2");
    expect(firstSvg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(firstSvg?.querySelectorAll("path")).toHaveLength(3);
    expect(
      [...first.container.querySelectorAll("*")].every(
        (node) => node.namespaceURI === "http://www.w3.org/2000/svg",
      ),
    ).toBe(true);
    first.unmount();
    expect(secondSvg?.isConnected).toBe(true);
  });
});
