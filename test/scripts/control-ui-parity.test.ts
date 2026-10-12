import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, expect, it } from "vitest";
import { fingerprintFixtures } from "../../scripts/control-ui-parity/fixture-fingerprint.ts";
import {
  compareCaptures,
  hash,
  writeGallery,
  type Capture,
} from "../../scripts/control-ui-parity/report.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const temporary = useAutoCleanupTempDirTracker(afterEach);
async function fixture(pixel: number | readonly number[], width = 1, id = "scene--profile") {
  const directory = temporary.make("parity-report-");
  const image = new photon.PhotonImage(
    new Uint8Array(
      Array.from({ length: width }, () =>
        typeof pixel === "number" ? [pixel, 0, 0, 255] : pixel,
      ).flat(),
    ),
    width,
    1,
  );
  let png: Uint8Array;
  try {
    png = image.get_bytes();
  } finally {
    image.free();
  }
  const contract = { expectedShots: [id], fixtures: hash("same-fixture") };
  const manifest: Capture = {
    version: 1,
    source: { head: "synthetic", dirty: [] },
    browser: "test",
    platform: "test",
    contract,
    catalog: hash(JSON.stringify(contract)),
    options: {},
    complete: true,
    failures: [],
    shots: [
      {
        id,
        file: `${id}.png`,
        scene: "scene",
        profile: "profile",
        label: "Synthetic",
        sha256: hash(png),
        width,
        height: 1,
      },
    ],
  };
  await writeFile(path.join(directory, `${id}.png`), png);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

it("compares decoded pixels and reports the exact changed-pixel count", async () => {
  const a = await fixture(0),
    b = await fixture(0),
    c = await fixture(2);
  const output = temporary.make("parity-output-");
  expect(await compareCaptures(a.directory, b.directory, output)).toBe(0);
  expect(await compareCaptures(a.directory, c.directory, output)).toBe(1);
  const reports = await Promise.all(
    (await readdir(output)).map(async (name) =>
      JSON.parse(await readFile(path.join(output, name, "report.json"), "utf8")),
    ),
  );
  expect(
    reports
      .map((report) => report.results[0].changedPixels)
      .toSorted((left, right) => left - right),
  ).toEqual([0, 1]);
});

it("links comparison images in directories with URL delimiters", async () => {
  const a = await fixture(0),
    b = await fixture(0);
  const parent = temporary.make("parity-paths-");
  const before = path.join(parent, "before #1"),
    after = path.join(parent, "after?2%");
  await rename(a.directory, before);
  await rename(b.directory, after);
  const output = temporary.make("parity-output-");
  expect(await compareCaptures(before, after, output)).toBe(0);
  const [name] = await readdir(output);
  const index = path.join(output, name!, "index.html");
  const html = await readFile(index, "utf8");
  for (const [alt, directory] of [
    ["Before", before],
    ["After", after],
  ]) {
    const src = new RegExp(`<img alt="${alt}" src="([^"]+)">`, "u").exec(html)![1]!;
    expect(fileURLToPath(new URL(src, pathToFileURL(index)))).toBe(
      path.join(directory!, "scene--profile.png"),
    );
  }
});

it.each([0, 1, 2, 3])(
  "accepts one-level noise but fails two-level changes in RGBA channel %i",
  async (channel) => {
    const baseline = [128, 128, 128, 128];
    const a = await fixture(baseline);
    for (const delta of [-1, 1, -2, 2]) {
      const b = await fixture(
        baseline.map((value, index) => value + (index === channel ? delta : 0)),
      );
      const output = temporary.make("parity-boundary-");
      const noise = Math.abs(delta) === 1;
      expect(await compareCaptures(a.directory, b.directory, output)).toBe(noise ? 0 : 1);
      const [name] = await readdir(output);
      const report = JSON.parse(await readFile(path.join(output, name!, "report.json"), "utf8"));
      expect(report.maxRasterNoiseChannelDelta).toBe(1);
      expect(report.rasterNoisePixels).toBe(noise ? 1 : 0);
      expect(report.results[0]).toMatchObject({
        changedPixels: noise ? 0 : 1,
        rasterNoisePixels: noise ? 1 : 0,
      });
      expect(await readFile(path.join(output, name!, "index.html"), "utf8")).toContain(
        `raster noise (≤1 level): ${noise ? 1 : 0} px`,
      );
    }
  },
);

it.each([
  ["route-apps--mobile-light", true],
  ["route-apps--mobile-dark", true],
  ["route-apps--mobile-reduced-motion", true],
  ["route-apps--desktop-light", false],
] as const)(
  "reports pixel differences for %s with only exact known exceptions",
  async (id, known) => {
    const a = await fixture(0, 1, id),
      b = await fixture(37, 1, id);
    await writeGallery(a.directory, a.manifest);
    expect(
      (await readFile(path.join(a.directory, "index.html"), "utf8")).includes(
        "Known nondeterministic:",
      ),
    ).toBe(known);
    const output = temporary.make("parity-known-");
    expect(await compareCaptures(a.directory, b.directory, output)).toBe(known ? 0 : 1);
    const [name] = await readdir(output);
    const report = JSON.parse(await readFile(path.join(output, name!, "report.json"), "utf8"));
    expect(report.changed).toBe(known ? 0 : 1);
    expect(report.knownNondeterministic).toBe(known ? 1 : 0);
    expect(report.results[0]).toMatchObject({
      status: known ? "known-nondeterministic" : "pixels",
      changedPixels: 1,
      rasterNoisePixels: 0,
      diff: `${id}.png`,
    });
    const html = await readFile(path.join(output, name!, "index.html"), "utf8");
    expect(html).toContain(known ? "Image clipping paints differently" : `${id}: pixels`);
    expect(await readFile(path.join(output, name!, `${id}.png`))).not.toHaveLength(0);
  },
);

it.each(["scene--profile", "route-apps--mobile-light"])(
  "fails changed dimensions for %s",
  async (id) => {
    const a = await fixture(0, 1, id),
      b = await fixture(0, 2, id);
    expect(await compareCaptures(a.directory, b.directory, temporary.make("parity-output-"))).toBe(
      1,
    );
  },
);

it.each(["metadata", "missing-shot", "incomplete", "duplicate", "unsafe-path", "checksum"])(
  "rejects %s evidence",
  async (defect) => {
    const a = await fixture(0),
      b = await fixture(0);
    const manifest = b.manifest;
    if (defect === "metadata") {
      manifest.browser = "";
    }
    if (defect === "missing-shot") {
      manifest.contract.expectedShots.push("other--profile");
      manifest.catalog = hash(JSON.stringify(manifest.contract));
    }
    if (defect === "incomplete") {
      manifest.complete = false;
    }
    if (defect === "duplicate") {
      manifest.shots.push(manifest.shots[0]!);
    }
    if (defect === "unsafe-path") {
      manifest.shots[0]!.file = "../outside.png";
    }
    if (defect === "checksum") {
      manifest.shots[0]!.sha256 = hash("changed-file");
    }
    await writeFile(path.join(b.directory, "manifest.json"), JSON.stringify(manifest));
    await expect(
      compareCaptures(a.directory, b.directory, temporary.make("parity-output-")),
    ).rejects.toThrow();
  },
);

it("rejects incompatible browser metadata even with identical images", async () => {
  const a = await fixture(0),
    b = await fixture(0);
  b.manifest.browser = "another-browser";
  await writeFile(path.join(b.directory, "manifest.json"), JSON.stringify(b.manifest));
  expect(await compareCaptures(a.directory, b.directory, temporary.make("parity-output-"))).toBe(1);
});

it("fingerprints resolved fixture changes independently of checkout location", () => {
  const scenario = (checkout: string, type: string) => ({
    methodResponses: { "config.schema": { schema: { type } } },
    nativePlugins: [
      {
        pluginId: "workboard",
        rootDir: path.join(checkout, "extensions/workboard"),
        source: "browser/index.ts",
      },
    ],
  });
  const a = path.resolve("fixture-checkout-a");
  const b = path.resolve("fixture-checkout-b");
  const fingerprint = fingerprintFixtures([scenario(a, "string")], a);
  expect(fingerprintFixtures([scenario(b, "string")], b)).toBe(fingerprint);
  expect(fingerprintFixtures([scenario(a, "integer")], a)).not.toBe(fingerprint);
});
