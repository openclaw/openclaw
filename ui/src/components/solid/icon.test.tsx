import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { BrandIcon, Icon, KeyboardIcon, type IconName } from "./icon.tsx";

afterEach(cleanup);

const svgNamespace = "http://www.w3.org/2000/svg";

describe("Solid icons", () => {
  it("updates geometry and inline presentation across stroke, filled, and custom-viewbox icons", () => {
    const [name, setName] = createSignal<IconName>("copy");
    const view = render(() => (
      <Icon name={name()} class="surface-icon" style={{ width: "16px" }} />
    ));
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("stroke-linecap")).toBe("round");
    expect(svg.getAttribute("stroke-linejoin")).toBe("round");
    expect(svg.classList.contains("surface-icon")).toBe(true);
    expect(svg.style.width).toBe("16px");
    expect(svg.querySelector("rect")?.getAttribute("width")).toBe("14");
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(
      "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
    );

    setName("gripVertical");
    flush();
    expect(svg.querySelector("rect")).toBeNull();
    const dots = [...svg.querySelectorAll("circle")];
    expect(dots).toHaveLength(6);
    expect(dots.every((dot) => dot.getAttribute("fill") === "currentColor")).toBe(true);
    expect(dots.every((dot) => dot.getAttribute("stroke") === "none")).toBe(true);

    setName("mark");
    flush();
    expect(svg.getAttribute("viewBox")).toBe("0 0 120 120");
    expect(svg.querySelector("rect")?.getAttribute("rx")).toBe("28");
    expect(svg.querySelector("path")?.getAttribute("stroke-width")).toBe("11");
    expect([...svg.querySelectorAll("*")].every((node) => node.namespaceURI === svgNamespace)).toBe(
      true,
    );
  });

  it("renders gradient, brand, and keyboard shapes in the SVG namespace", () => {
    const view = render(() => (
      <>
        <Icon name="lobster" />
        <BrandIcon name="github" class="brand-icon" />
        <KeyboardIcon symbol="⌘" style={{ "stroke-width": "2.3" }} />
      </>
    ));
    const svgs = [...view.container.querySelectorAll("svg")];
    expect(svgs).toHaveLength(3);
    expect(svgs[0]?.getAttribute("viewBox")).toBe("0 0 120 120");
    expect(svgs[0]?.querySelector("linearGradient")?.getAttribute("id")).toBe("lob-g");
    expect(svgs[0]?.querySelectorAll("stop")).toHaveLength(2);
    expect(svgs[0]?.querySelector("path")?.getAttribute("fill")).toBe("url(#lob-g)");
    expect(svgs[1]?.getAttribute("width")).toBe("16");
    expect(svgs[1]?.classList.contains("icon--filled")).toBe(true);
    expect(svgs[1]?.classList.contains("brand-icon")).toBe(true);
    expect(svgs[1]?.getAttribute("stroke")).toBe("none");
    expect(svgs[2]?.style.strokeWidth).toBe("2.3");
    expect(
      [...view.container.querySelectorAll("*")].every((node) => node.namespaceURI === svgNamespace),
    ).toBe(true);
  });

  it("keeps independent instances and only exposes explicitly named icons to assistive technology", () => {
    const [label, setLabel] = createSignal<string | undefined>("Information");
    const view = render(() => (
      <>
        <Icon name="info" aria-label={label()} />
        <Icon name="info" />
      </>
    ));
    const svgs = [...view.container.querySelectorAll("svg")];
    expect(view.getByRole("img", { name: "Information" })).toBe(svgs[0]);
    expect(svgs[0]).not.toBe(svgs[1]);
    expect(svgs[1]?.getAttribute("aria-hidden")).toBe("true");
    setLabel(undefined);
    flush();
    expect(view.queryByRole("img")).toBeNull();
    expect(svgs[0]?.getAttribute("aria-hidden")).toBe("true");
  });
});
