import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, expect, it } from "vitest";
import {
  analyzeReloadFrames,
  type ReloadAnimationSample,
} from "../../scripts/perf/warm-reload-frames.ts";
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

it("groups attributed shimmer phase while retaining simultaneous content, identity and geometry changes", async () => {
  const directory = temporary.make("reload-animation-");
  const changes: Array<Array<[number, number]>> = [
    [],
    [
      [0, 200],
      [1, 200],
      [128, 200],
      [129, 200],
    ],
    [
      [0, 100],
      [1, 100],
      [128, 100],
      [129, 100],
      [50, 200],
      [51, 200],
      [178, 200],
      [179, 200],
    ],
    [
      [0, 240],
      [1, 240],
      [128, 240],
      [129, 240],
      [50, 200],
      [51, 200],
      [178, 200],
      [179, 200],
    ],
    [
      [0, 20],
      [1, 20],
      [128, 20],
      [129, 20],
      [50, 200],
      [51, 200],
      [178, 200],
      [179, 200],
    ],
  ];
  const frames = await Promise.all(
    changes.map(async (edits, index) => ({
      file: await png(directory, `frame-${index}.png`, edits),
      atMs: index * 10,
    })),
  );
  const samples: ReloadAnimationSample[] = changes.map((_, index) => ({
    atMs: index * 10,
    animations: [
      {
        name: "shimmer",
        key: "same-element",
        kind: "shimmer",
        active: true,
        signature: index < 3 ? "same-content-and-layout" : "identity-changed",
        x: index === 4 ? 1 : 0,
        y: 0,
        width: 16,
        height: 16,
      },
    ],
  }));
  const report = await analyzeReloadFrames({
    frames,
    animationSamples: samples,
    masks: [],
    outputDir: directory,
    regions: [
      { name: "sidebar", x: 0, y: 0, width: 16, height: 16 },
      { name: "transcript", x: 40, y: 0, width: 16, height: 16 },
    ],
    minChangedPixels: 3,
    minChangedRatio: 0,
  });
  expect(report).toMatchObject({
    distinctStates: 5,
    transitionCount: 4,
    unmasked: { distinctStates: 5, transitionCount: 4 },
  });
  expect(report.visibleChangeCensus).toMatchObject({
    distinctStates: 4,
    transitionCount: 3,
    lastVisualChangeMs: 40,
    regions: {
      sidebar: { transitionCount: 2 },
      transcript: { transitionCount: 1 },
    },
  });
  expect(
    report.visibleChangeCensus.timeline.map(({ atMs, regions }) => ({ atMs, regions })),
  ).toEqual([
    { atMs: 0, regions: ["sidebar", "transcript"] },
    { atMs: 20, regions: ["transcript"] },
    { atMs: 30, regions: ["sidebar"] },
    { atMs: 40, regions: ["sidebar"] },
  ]);
  expect(report.visibleChangeCensus.suppressedAnimationPairs.map(({ atMs }) => atMs)).toEqual([
    10, 20,
  ]);
  expect(report.visibleChangeCensus.contactSheets[0]).toBe("visible-contact-sheet-01.png");
});

it("retains gradual unexplained changes and avoids inventing a state when a matched fade finishes", async () => {
  const directory = temporary.make("reload-fade-");
  const frames = await Promise.all(
    [0, 1, 2, 3, 4].map(async (index) => ({
      file: await png(directory, `fade-${index}.png`, [
        ...[0, 1, 128, 129].map((pixel): [number, number] => [
          pixel,
          [160, 180, 200, 250, 250][index]!,
        ]),
        ...[50, 51, 178, 179].map((pixel): [number, number] => [pixel, Math.min(index, 3) * 8]),
      ]),
      atMs: index * 10,
    })),
  );
  const report = await analyzeReloadFrames({
    frames,
    masks: [],
    regions: [],
    outputDir: directory,
    minChangedPixels: 3,
    minChangedRatio: 0,
    animationSamples: [0, 1, 2, 3, 4].map((index) => ({
      atMs: index * 10,
      animations: [
        {
          name: "fade",
          key: "fade-target",
          kind: "fade",
          signature: "same-visible-content",
          active: index < 3,
          x: 0,
          y: 0,
          width: 16,
          height: 16,
        },
      ],
    })),
  });
  expect(report.transitionCount).toBe(3);
  expect(report.visibleChangeCensus.timeline.map(({ atMs }) => atMs)).toEqual([0, 20]);
  expect(report.visibleChangeCensus).toMatchObject({ distinctStates: 2, transitionCount: 1 });
});

it("counts first painted content and spatial changes despite identical ahead-of-paint DOM fade signatures", async () => {
  const directory = temporary.make("reload-fade-paint-");
  const patterns: Array<Array<[number, number]>> = [
    [],
    [0, 1, 128, 129].map((pixel) => [pixel, 180]),
    [0, 1, 128, 129].map((pixel) => [pixel, 240]),
    [2, 3, 130, 131].map((pixel) => [pixel, 240]),
  ];
  const frames = await Promise.all(
    patterns.map(async (edits, index) => ({
      file: await png(directory, `paint-${index}.png`, edits),
      atMs: index * 10,
    })),
  );
  const report = await analyzeReloadFrames({
    frames,
    masks: [],
    regions: [],
    outputDir: directory,
    minChangedPixels: 3,
    minChangedRatio: 0,
    animationSamples: patterns.map((_, index) => ({
      atMs: index * 10,
      animations: [
        {
          name: "fade",
          key: "same-target",
          kind: "fade",
          signature: "DOM-already-has-final-content",
          active: true,
          x: 0,
          y: 0,
          width: 16,
          height: 16,
        },
      ],
    })),
  });
  expect(report.transitionCount).toBe(3);
  expect(report.visibleChangeCensus.timeline.map(({ atMs }) => atMs)).toEqual([0, 10, 30]);
  expect(report.visibleChangeCensus.suppressedAnimationPairs.map(({ atMs }) => atMs)).toEqual([20]);
});

it("does not apply a current animation mask when matching a different historical content state", async () => {
  const directory = temporary.make("reload-animation-history-");
  const content: Array<[number, number]> = [0, 1, 128, 129].map((pixel) => [pixel, 200]);
  const chrome: Array<[number, number]> = [50, 51, 178, 179].map((pixel) => [pixel, 200]);
  const frames = await Promise.all(
    [[...content, ...chrome], [], chrome].map(async (edits, index) => ({
      file: await png(directory, `history-${index}.png`, edits),
      atMs: index * 10,
    })),
  );
  const report = await analyzeReloadFrames({
    frames,
    masks: [],
    regions: [],
    outputDir: directory,
    minChangedPixels: 3,
    minChangedRatio: 0,
    animationSamples: frames.map((frame, index) => ({
      atMs: frame.atMs,
      animations: [
        {
          name: "shimmer",
          key: "target",
          kind: "shimmer",
          signature: index ? "skeleton-B" : "content-A",
          active: true,
          x: 0,
          y: 0,
          width: 16,
          height: 16,
        },
      ],
    })),
  });
  expect(report.visibleChangeCensus).toMatchObject({ distinctStates: 3, transitionCount: 2 });
  expect(report.visibleChangeCensus.timeline.map(({ stateId }) => stateId)).toEqual([0, 1, 2]);
});

it("accumulates a region's small changes independently when another region changes every frame", async () => {
  const directory = temporary.make("reload-region-baselines-");
  const frames = await Promise.all(
    [0, 1, 2, 3].map(async (index) => ({
      file: await png(directory, `regions-${index}.png`, [
        ...[0, 1, 128, 129].map((pixel): [number, number] => [pixel, 100 + index * 30]),
        ...[50, 51, 178, 179].map((pixel): [number, number] => [pixel, index * 8]),
        ...[80, 81, 208, 209].map((pixel): [number, number] => [pixel, index % 2 ? 200 : 0]),
      ]),
      atMs: index * 10,
    })),
  );
  const report = await analyzeReloadFrames({
    frames,
    masks: [],
    outputDir: directory,
    minChangedPixels: 3,
    minChangedRatio: 0,
    regions: [
      { name: "regionA", x: 40, y: 0, width: 16, height: 16 },
      { name: "regionB", x: 70, y: 0, width: 16, height: 16 },
    ],
    animationSamples: frames.map(({ atMs }) => ({
      atMs,
      animations: [
        {
          name: "shimmer",
          key: "animation",
          kind: "shimmer",
          signature: "same-skeleton",
          active: true,
          x: 0,
          y: 0,
          width: 16,
          height: 16,
        },
      ],
    })),
  });
  expect(report.visibleChangeCensus.suppressedAnimationPairs).toHaveLength(3);
  expect(report.visibleChangeCensus.regions.regionB?.timeline.map(({ atMs }) => atMs)).toEqual([
    0, 10, 20, 30,
  ]);
  expect(report.visibleChangeCensus.regions.regionA?.timeline.map(({ atMs }) => atMs)).toEqual([
    0, 20,
  ]);
});
