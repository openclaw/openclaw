import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, expect, it } from "vitest";
import { canonicalLobsterLook, lobsterLookStyle, renderLobsterSvg } from "./lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";

const container = document.createElement("div");
afterEach(() => {
  container.remove();
  container.removeAttribute("class");
  container.removeAttribute("style");
});

function sampleOutline(path: SVGPathElement, steps: number): DOMPoint[] {
  const length = path.getTotalLength();
  return Array.from({ length: steps + 1 }, (_, step) =>
    path.getPointAtLength((step / steps) * length),
  );
}

it("wraps Clawnstantine's sash to the shell edge with the highlight inset", () => {
  const palette = expectDefined(
    LOBSTER_PET_PALETTES.find((entry) => entry.id === "clawnstantine"),
    "Clawnstantine palette",
  );
  document.body.append(container);
  render(renderLobsterSvg(canonicalLobsterLook(palette), { standalone: true }), container);
  const dome = expectDefined(
    container.querySelector<SVGPathElement>(".lob-standard-dome"),
    "shell path",
  );
  const sash = expectDefined(
    container.querySelector<SVGPathElement>('.lob-clawnstantine > path[fill="#e5bc62"]'),
    "sash path",
  );
  const highlight = expectDefined(
    container.querySelector<SVGPathElement>('.lob-clawnstantine > path[stroke="#fff0bc"]'),
    "highlight path",
  );
  const shellOutline = sampleOutline(dome, 512);
  const distanceToShell = (point: DOMPoint) =>
    Math.min(...shellOutline.map((edge) => Math.hypot(point.x - edge.x, point.y - edge.y)));
  const sashOutline = sampleOutline(sash, 128);
  // Allow subpixel error from sampling the curved boundary, not a floating tip.
  for (const point of sashOutline) {
    expect(dome.isPointInFill(point) || distanceToShell(point) < 0.65).toBe(true);
  }
  expect(
    sashOutline.filter((point) => point.x < 44 && point.y > 80 && distanceToShell(point) < 0.65)
      .length,
  ).toBeGreaterThanOrEqual(3);

  const radius = Number(highlight.getAttribute("stroke-width")) / 2;
  for (const point of sampleOutline(highlight, 64)) {
    for (const [dx, dy] of [
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
    ] as const) {
      expect(sash.isPointInFill(new DOMPoint(point.x + dx, point.y + dy))).toBe(true);
    }
  }
});

it.each([
  ["taylorpinch", ".lob-microphone"],
  ["shellvis", ".lob-microphone"],
  ["leonardodepinchy", ".lob-leonardodepinchy__brush"],
  ["alexandergrahamshell", ".lob-telephone-receiver"],
] as const)("keeps %s’s prop attached through claw sizes and wave poses", (id, propSelector) => {
  const palette = expectDefined(
    LOBSTER_PET_PALETTES.find((entry) => entry.id === id),
    "prop palette",
  );
  document.body.append(container);
  container.className = `lobster-pet lobster-pet--palette-${id} lobster-pet--act-wave`;
  for (const clawSize of ["dainty", "regular", "mighty"] as const) {
    const look = { ...canonicalLobsterLook(palette), clawSize };
    container.style.cssText = lobsterLookStyle(look);
    render(renderLobsterSvg(look), container);
    const claw = expectDefined(container.querySelector<SVGGElement>(".lob-claw--r"), "right claw");
    const hand = expectDefined(
      claw.querySelector<SVGPathElement>(`path:not(${propSelector})`),
      "hand",
    );
    const prop = container.querySelectorAll<SVGPathElement>(propSelector);
    expect(prop.length).toBeGreaterThan(0);
    const wave = expectDefined(
      claw
        .getAnimations()
        .find((animation) => (animation as CSSAnimation).animationName === "lobster-pet-wave"),
      "wave animation",
    );
    wave.pause();
    const poses = new Set<string>();
    for (const time of [0, 280, 560, 840]) {
      wave.currentTime = time;
      const matrix = expectDefined(hand.getCTM(), "hand transform");
      const transform = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
      poses.add(transform.join(","));
      for (const part of prop) {
        expect(part.parentElement).toBe(claw);
        const attached = expectDefined(part.getCTM(), "prop transform");
        expect([attached.a, attached.b, attached.c, attached.d, attached.e, attached.f]).toEqual(
          transform,
        );
      }
    }
    expect(poses.size).toBeGreaterThan(1);
  }
  render(renderLobsterSvg(canonicalLobsterLook(palette), { bindle: true }), container);
  expect(container.querySelector(propSelector)).not.toBeNull();
  expect(container.querySelector(".lob-bindle")).toBeNull();
  render(renderLobsterSvg(canonicalLobsterLook(palette), { shell: true }), container);
  expect(container.querySelector(propSelector)).toBeNull();
});

it("keeps the moving-in bag for unoccupied claws", () => {
  for (const id of ["crimson", "blue"]) {
    const palette = expectDefined(
      LOBSTER_PET_PALETTES.find((entry) => entry.id === id),
      "unoccupied palette",
    );
    render(renderLobsterSvg(canonicalLobsterLook(palette), { bindle: true }), container);
    expect(container.querySelector(".lob-bindle")).not.toBeNull();
  }
});
