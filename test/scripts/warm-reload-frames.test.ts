import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, expect, it } from "vitest";
import { analyzeReloadFrames } from "../../scripts/perf/warm-reload-frames.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const temporary = useAutoCleanupTempDirTracker(afterEach);

async function png(
  directory: string,
  name: string,
  edits: Array<[number, number]> = [],
  width = 128,
) {
  const pixels = new Uint8Array(width * 80 * 4);
  for (let offset = 3; offset < pixels.length; offset += 4) {
    pixels[offset] = 255;
  }
  for (const [pixel, value] of edits) {
    pixels[pixel * 4] = value;
  }
  const image = new photon.PhotonImage(pixels, width, 80);
  const file = path.join(directory, name);
  try {
    await writeFile(file, image.get_bytes());
  } finally {
    image.free();
  }
  return file;
}

it("counts visible regional states and revisits while reporting changes hidden by an explicit mask", async () => {
  const directory = temporary.make("reload-pixels-");
  const caret: Array<[number, number]> = [60, 61, 62, 63, 64, 65, 66, 67].map((pixel) => [
    pixel,
    255,
  ]);
  const sidebar: Array<[number, number]> = [0, 1, 128, 129].map((pixel) => [pixel, 200]);
  const frames = [
    { file: await png(directory, "initial.png"), atMs: 0 },
    { file: await png(directory, "caret.png", caret), atMs: 10 },
    { file: await png(directory, "sidebar.png", [...sidebar, ...caret]), atMs: 20 },
    { file: await png(directory, "return.png"), atMs: 30 },
    {
      file: await png(directory, "noise.png", [
        [0, 12],
        [1, 12],
        [128, 12],
        [129, 12],
      ]),
      atMs: 40,
    },
  ];
  const report = await analyzeReloadFrames({
    frames,
    regions: [
      { name: "sidebar", x: 0, y: 0, width: 16, height: 16 },
      { name: "header", x: 50, y: 0, width: 60, height: 10 },
    ],
    masks: [{ name: "caret", x: 60, y: 0, width: 8, height: 1, reason: "Synthetic caret blink" }],
    outputDir: directory,
    minChangedPixels: 3,
    minChangedRatio: 0.01,
  });
  expect(report).toMatchObject({
    width: 128,
    height: 80,
    capturedFrames: 5,
    distinctStates: 2,
    transitionCount: 2,
    lastVisualChangeMs: 30,
    maskedPixels: 8,
    regionBounds: [
      { name: "sidebar", width: 16, height: 16 },
      { name: "header", width: 60, height: 10 },
    ],
    masks: [{ name: "caret", reason: "Synthetic caret blink" }],
    unmasked: { distinctStates: 3, transitionCount: 3, lastVisualChangeMs: 30 },
  });
  expect(report.timeline.map(({ atMs, stateId, regions }) => ({ atMs, stateId, regions }))).toEqual(
    [
      { atMs: 0, stateId: 0, regions: ["sidebar", "header"] },
      { atMs: 20, stateId: 1, regions: ["sidebar"] },
      { atMs: 30, stateId: 0, regions: ["sidebar"] },
    ],
  );
  expect(report.regions).toMatchObject({
    sidebar: { distinctStates: 2, transitionCount: 2 },
    header: { distinctStates: 1, transitionCount: 0 },
  });
  // The tiny sidebar change is below the viewport threshold, but remains a state.
  expect(report.timeline[1]).toMatchObject({ changedPixels: 4, comparedPixels: 10232 });
  const sheet = photon.PhotonImage.new_from_byteslice(
    await readFile(path.join(directory, report.contactSheets[0]!)),
  );
  try {
    expect([sheet.get_width(), sheet.get_height()]).toEqual([256, 124]);
    const pixels = sheet.get_raw_pixels();
    expect(pixels[(44 * 256 + 128) * 4]).toBe(200);
  } finally {
    sheet.free();
  }
});

it("rejects mixed viewport dimensions and nonchronological captures rather than inventing states", async () => {
  const directory = temporary.make("reload-invalid-");
  const first = await png(directory, "first.png");
  const smaller = await png(directory, "smaller.png", [], 64);
  const options = { regions: [], masks: [], outputDir: directory };
  await expect(
    analyzeReloadFrames({
      ...options,
      frames: [
        { file: first, atMs: 0 },
        { file: smaller, atMs: 10 },
      ],
    }),
  ).rejects.toThrow("Frame dimensions changed");
  await expect(
    analyzeReloadFrames({
      ...options,
      frames: [
        { file: first, atMs: 10 },
        { file: first, atMs: 0 },
      ],
    }),
  ).rejects.toThrow("capture order");
});
