import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { renderSolidSnapshot } from "../../lib/dom/solid-snapshot.ts";
import { StrokeIcon } from "./stroke-icon.tsx";

afterEach(cleanup);

it("forwards native root attributes and refs without replacing its SVG", () => {
  const [hidden, setHidden] = createSignal<"true" | undefined>("true");
  let referenced: SVGSVGElement | undefined;
  const view = render(() => (
    <StrokeIcon
      ref={(node) => (referenced = node)}
      id="native-stroke"
      aria-hidden={hidden()}
      width="13"
      height="13"
      viewBox="0 0 16 16"
      stroke-width="1.4"
    >
      <path d="M3 4l3 3-3 3M8 11h5" />
    </StrokeIcon>
  ));
  const root = view.container.querySelector("svg");
  expect(root).toBe(referenced);
  expect(root?.getAttribute("aria-hidden")).toBe("true");
  expect(root?.getAttribute("viewBox")).toBe("0 0 16 16");
  expect(root?.getAttribute("stroke-width")).toBe("1.4");
  expect(root?.getAttribute("width")).toBe("13");
  expect(root?.getAttribute("height")).toBe("13");
  setHidden(undefined);
  flush();
  expect(view.container.querySelector("#native-stroke")).toBe(root);
  expect(root?.hasAttribute("aria-hidden")).toBe(false);
  expect(root?.children).toHaveLength(1);
});

it("includes native overrides in a synchronous snapshot during parent rendering", () => {
  const view = render(() => (
    <div>
      {renderSolidSnapshot(() => (
        <StrokeIcon viewBox="0 0 16 16" width="13" height="13" stroke-width="1.4">
          <path d="M3 4l3 3-3 3M8 11h5" />
        </StrokeIcon>
      ))}
    </div>
  ));
  const root = view.container.querySelector("svg");
  expect(root?.getAttribute("viewBox")).toBe("0 0 16 16");
  expect(root?.getAttribute("width")).toBe("13");
  expect(root?.getAttribute("height")).toBe("13");
  expect(root?.getAttribute("stroke-width")).toBe("1.4");
  expect(root?.querySelector("path")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
});

it("retains independent SVG roots while child geometry and branches update", () => {
  const [active, setActive] = createSignal(false);
  const [width, setWidth] = createSignal(4);
  const view = render(() => (
    <>
      <StrokeIcon> {active() ? <circle cx="12" cy="12" r="6" /> : <path d="M2 3h4" />}</StrokeIcon>
      <StrokeIcon>
        <rect width={width()} height="8" />
      </StrokeIcon>
    </>
  ));
  const roots = [...view.container.querySelectorAll("svg")];
  expect(roots).toHaveLength(2);
  expect(roots[0]).not.toBe(roots[1]);
  expect(roots[0]?.firstChild?.textContent).toBe(" ");
  expect(roots[0]?.querySelector("path")?.getAttribute("d")).toBe("M2 3h4");
  expect(roots[1]?.querySelector("rect")?.getAttribute("width")).toBe("4");
  for (const root of roots) {
    expect(Object.fromEntries([...root.attributes].map((attr) => [attr.name, attr.value]))).toEqual(
      {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
    );
  }

  setActive(true);
  setWidth(9);
  flush();
  const updatedRoots = [...view.container.querySelectorAll("svg")];
  expect(updatedRoots[0]).toBe(roots[0]);
  expect(updatedRoots[1]).toBe(roots[1]);
  expect(roots[0]?.querySelector("path")).toBeNull();
  expect(roots[0]?.querySelector("circle")?.getAttribute("r")).toBe("6");
  expect(roots[0]?.firstChild?.textContent).toBe(" ");
  expect(roots[1]?.querySelector("rect")?.getAttribute("width")).toBe("9");
  expect(
    [...view.container.querySelectorAll("*")].every(
      (node) => node.namespaceURI === "http://www.w3.org/2000/svg",
    ),
  ).toBe(true);
});
