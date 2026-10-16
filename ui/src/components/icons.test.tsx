import { describe, expect, it } from "vitest";
import { LitContent } from "../lit/solid-content.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { iconData } from "./icon-data.ts";
import { renderIconRegistry, toolIcons } from "./icons-tools.ts";
import { icons } from "./icons.ts";

const solidIcons = renderIconRegistry(iconData);

describe("icon registries", () => {
  it("renders independent placements directly in Solid", () => {
    const storedIcon = solidIcons.copy;
    const first = mountSolid(() => <>{storedIcon()}</>);
    const second = mountSolid(() => <>{storedIcon()}</>);
    const firstSvg = first.container.querySelector("svg");
    const secondSvg = second.container.querySelector("svg");
    expect(firstSvg).not.toBeNull();
    expect(firstSvg).not.toBe(secondSvg);
    expect(firstSvg?.getAttribute("stroke")).toBe("currentColor");
    expect(firstSvg?.getAttribute("stroke-width")).toBe("2");
    expect(firstSvg?.querySelector("rect")?.getAttribute("width")).toBe("14");
    first.unmount();
    expect(secondSvg?.isConnected).toBe(true);
  });

  it("keeps independent placements in the remaining Lit slots", () => {
    const storedIcon = icons.copy;
    const first = mountSolid(() => <LitContent value={storedIcon} />);
    const second = mountSolid(() => <LitContent value={storedIcon} />);
    const firstSvg = first.container.querySelector("svg");
    const secondSvg = second.container.querySelector("svg");
    expect(firstSvg).not.toBeNull();
    expect(secondSvg).not.toBeNull();
    expect(firstSvg).not.toBe(secondSvg);
    first.unmount();
    expect(secondSvg?.isConnected).toBe(true);
  });

  it("preserves tool geometry, filled shapes, and nested SVG gradients", () => {
    const view = mountSolid(() => (
      <>{[toolIcons.lightbulb(), solidIcons.gripVertical(), solidIcons.lobster()]}</>
    ));
    const svgs = [...view.container.querySelectorAll("svg")];
    expect(svgs).toHaveLength(3);
    expect(svgs[0]?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svgs[0]?.querySelectorAll("path")).toHaveLength(3);
    expect(svgs[1]?.querySelectorAll('circle[fill="currentColor"][stroke="none"]')).toHaveLength(6);
    expect(svgs[2]?.getAttribute("viewBox")).toBe("0 0 120 120");
    expect(svgs[2]?.querySelector("linearGradient")?.id).toBe("lob-g");
    expect(svgs[2]?.querySelectorAll("stop")).toHaveLength(2);
    expect(svgs[2]?.querySelector("path")?.getAttribute("fill")).toBe("url(#lob-g)");
    expect(
      [...view.container.querySelectorAll("*")].every(
        (node) => node.namespaceURI === "http://www.w3.org/2000/svg",
      ),
    ).toBe(true);
  });
});
