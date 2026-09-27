import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, expect, it } from "vitest";
import { canonicalLobsterLook, renderLobsterSvg } from "./lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";

const container = document.createElement("div");
afterEach(() => container.remove());

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
