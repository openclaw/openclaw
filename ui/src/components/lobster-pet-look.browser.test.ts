import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalLobsterLook, lobsterLookStyle, renderLobsterSvg } from "./lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";

const container = document.createElement("div");
const lookFor = (id: string) => {
  const palette = LOBSTER_PET_PALETTES.find((entry) => entry.id === id);
  return canonicalLobsterLook(expectDefined(palette, id));
};
const query = <T extends Element>(selector: string, root: ParentNode = container) =>
  expectDefined(root.querySelector<T>(selector), selector);
const matrixValues = ({ a, b, c, d, e, f }: DOMMatrix) => [a, b, c, d, e, f];
const isWave = (animation: Animation) =>
  (animation as CSSAnimation).animationName === "lobster-pet-wave";
beforeEach(() => document.body.append(container));
afterEach(() => {
  container.remove();
  container.removeAttribute("class");
  container.removeAttribute("style");
});

function sampleOutline(path: SVGPathElement, steps: number): DOMPoint[] {
  const length = path.getTotalLength();
  return Array.from({ length: steps + 1 }, (_, i) => path.getPointAtLength((i / steps) * length));
}

it("wraps Clawnstantine's sash to the shell edge with the highlight inset", () => {
  container.replaceChildren(renderLobsterSvg(lookFor("clawnstantine"), { standalone: true }));
  const dome = query<SVGPathElement>(".lob-standard-dome");
  const sash = query<SVGPathElement>('.lob-clawnstantine > path[fill="#e5bc62"]');
  const highlight = query<SVGPathElement>('.lob-clawnstantine > path[stroke="#fff0bc"]');
  const shellOutline = sampleOutline(dome, 512);
  const distanceToShell = (point: DOMPoint) =>
    Math.min(...shellOutline.map((edge) => Math.hypot(point.x - edge.x, point.y - edge.y)));
  const sashOutline = sampleOutline(sash, 128);
  // Allow subpixel error from sampling the curved boundary, not a floating tip.
  for (const point of sashOutline) {
    expect(dome.isPointInFill(point) || distanceToShell(point) < 0.65).toBe(true);
  }
  const tips = sashOutline.filter((p) => p.x < 44 && p.y > 80 && distanceToShell(p) < 0.65);
  expect(tips.length).toBeGreaterThanOrEqual(3);

  const radius = Number(highlight.getAttribute("stroke-width")) / 2;
  for (const point of sampleOutline(highlight, 64)) {
    for (const offset of [radius, -radius]) {
      expect(sash.isPointInFill(new DOMPoint(point.x + offset, point.y))).toBe(true);
      expect(sash.isPointInFill(new DOMPoint(point.x, point.y + offset))).toBe(true);
    }
  }
});

it.each([
  ["taylorpinch", ".lob-microphone"],
  ["shellvis", ".lob-microphone"],
  ["leonardodepinchy", ".lob-leonardodepinchy__brush"],
  ["alexandergrahamshell", ".lob-telephone-receiver"],
] as const)("keeps %s’s prop attached through claw sizes and wave poses", (id, propSelector) => {
  const canonical = lookFor(id);
  container.className = `lobster-pet lobster-pet--palette-${id} lobster-pet--act-wave`;
  for (const clawSize of ["dainty", "regular", "mighty"] as const) {
    const look = { ...canonical, clawSize };
    container.style.cssText = lobsterLookStyle(look);
    container.replaceChildren(renderLobsterSvg(look));
    const claw = query<SVGGElement>(".lob-claw--r");
    const hand = query<SVGPathElement>(`path:not(${propSelector})`, claw);
    const prop = container.querySelectorAll<SVGPathElement>(propSelector);
    expect(prop.length).toBeGreaterThan(0);
    const wave = expectDefined(claw.getAnimations().find(isWave), "wave animation");
    wave.pause();
    const poses = new Set<string>();
    for (const time of [0, 280, 560, 840]) {
      wave.currentTime = time;
      const transform = matrixValues(expectDefined(hand.getCTM(), "hand transform"));
      poses.add(transform.join(","));
      for (const part of prop) {
        expect(part.parentElement).toBe(claw);
        expect(matrixValues(expectDefined(part.getCTM(), "prop transform"))).toEqual(transform);
      }
    }
    expect(poses.size).toBeGreaterThan(1);
  }
  container.replaceChildren(renderLobsterSvg(canonical, { bindle: true }));
  expect(container.querySelector(propSelector)).not.toBeNull();
  expect(container.querySelector(".lob-bindle")).toBeNull();
  container.replaceChildren(renderLobsterSvg(canonical, { shell: true }));
  expect(container.querySelector(propSelector)).toBeNull();
});

it("keeps the moving-in bag for unoccupied claws", () => {
  for (const id of ["crimson", "blue"]) {
    container.replaceChildren(renderLobsterSvg(lookFor(id), { bindle: true }));
    expect(container.querySelector(".lob-bindle")).not.toBeNull();
  }
});
