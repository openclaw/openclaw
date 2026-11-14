import { expect, it } from "vitest";

// Public assets cannot be imported; the lazy glob only lists them and fetch reads the served file.
const icons = Object.keys(import.meta.glob("../../public/provider-icons/ProviderIcon-*.svg")).map(
  (path) => path.split("/").pop()!,
);

const SIZE = 512;
// Marks share one silhouette area (OpenAI's knot at today's size); long sides stay under 88%.
const AREA = 0.52;
const CAP = 0.88;

type Point = [number, number];

const cross = (o: Point, a: Point, b: Point) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function hullArea(points: Point[]) {
  const sorted = points.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (input: Point[]) => {
    const chain: Point[] = [];
    for (const point of input) {
      while (chain.length > 1 && cross(chain.at(-2)!, chain.at(-1)!, point) <= 0) {
        chain.pop();
      }
      chain.push(point);
    }
    return chain.slice(0, -1);
  };
  const hull = [...half(sorted), ...half(sorted.toReversed())];
  let area = 0;
  hull.forEach(([ax, ay], index) => {
    const [bx, by] = hull[(index + 1) % hull.length]!;
    area += ax * by - bx * ay;
  });
  return Math.abs(area) / 2;
}

async function measure(svg: string, root: string, width: number, height: number) {
  // Render at the viewBox aspect so pixels map to viewBox units equally on both axes.
  const [w, h] =
    width >= height
      ? [SIZE, Math.round((SIZE * height) / width)]
      : [Math.round((SIZE * width) / height), SIZE];
  const sized = svg.replace(
    root,
    root
      .replace(/\s(width|height)="[^"]*"/g, "")
      .replace(/^<svg\b/, `<svg width="${w}" height="${h}"`),
  );
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized.replaceAll("currentColor", "#000"))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, 0, 0, w, h);
  const pixels = context.getImageData(0, 0, w, h).data;
  let [left, top, right, bottom] = [w, h, -1, -1];
  // Row extremes are enough for the convex silhouette people read as a mark's size.
  const points: Point[] = [];
  for (let y = 0; y < h; y++) {
    let start = -1;
    let end = -1;
    for (let x = 0; x < w; x++) {
      if (pixels[(y * w + x) * 4 + 3]! > 8) {
        start = start < 0 ? x : start;
        end = x + 1;
      }
    }
    if (start >= 0) {
      points.push([start, y], [end, y], [start, y + 1], [end, y + 1]);
      left = Math.min(left, start);
      right = Math.max(right, end);
      top = Math.min(top, y);
      bottom = y + 1;
    }
  }
  const unit = width / w;
  return { left, top, right, bottom, unit, silhouette: hullArea(points) * unit * unit };
}

it("frames every bundled provider mark at one optical size", async () => {
  expect(icons).not.toHaveLength(0);
  const misframed: string[] = [];
  for (const file of icons) {
    const svg = await (await fetch(`/provider-icons/${file}`)).text();
    const root = svg.match(/<svg\b[^>]*>/)![0];
    const [x, y, width, height] = root
      .match(/viewBox="([^"]+)"/)![1]!
      .trim()
      .split(/[\s,]+/)
      .map(Number) as [number, number, number, number];
    const bounds = await measure(svg, root, width, height);
    const long = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) * bounds.unit;
    const side = Math.max(Math.sqrt(bounds.silhouette / AREA), long / CAP);
    const centerX = x + ((bounds.left + bounds.right) / 2) * bounds.unit;
    const centerY = y + ((bounds.top + bounds.bottom) / 2) * bounds.unit;
    const offset = Math.max(
      Math.abs(centerX - (x + width / 2)),
      Math.abs(centerY - (y + height / 2)),
    );
    if (
      /\s(width|height)=/.test(root) ||
      width !== height ||
      !(Math.abs(side / width - 1) <= 0.03) ||
      offset > width * 0.015
    ) {
      const fix = [centerX - side / 2, centerY - side / 2, side, side].map((value) =>
        Number(value.toFixed(3)),
      );
      misframed.push(`${file}: use viewBox="${fix.join(" ")}" without width/height`);
    }
  }
  expect(misframed).toEqual([]);
});
