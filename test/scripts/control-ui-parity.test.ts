import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, expect, it } from "vitest";
import { fingerprintFixtures } from "../../scripts/control-ui-parity/fixture-fingerprint.ts";
import * as parity from "../../scripts/control-ui-parity/report.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const saveManifest = ({ directory, manifest }: { directory: string; manifest: parity.Capture }) =>
  writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
const htmlAt = (directory: string) => readFile(path.join(directory, "index.html"), "utf8");
async function compare(before: string, after: string, expected: number) {
  const output = temporary.make("parity-output-");
  expect(await parity.compareCaptures(before, after, output)).toBe(expected);
  const [name] = await readdir(output);
  return path.join(output, name!);
}
async function fixture(pixel: number | readonly number[], width = 1, id = "scene--profile") {
  const directory = temporary.make("parity-report-");
  const rgba = typeof pixel === "number" ? [pixel, 0, 0, 255] : pixel;
  const pixels = new Uint8Array(width * 4);
  for (let x = 0; x < width; x++) {
    pixels.set(rgba, x * 4);
  }
  const image = new photon.PhotonImage(pixels, width, 1);
  let png: Uint8Array;
  try {
    png = image.get_bytes();
  } finally {
    image.free();
  }
  const contract = { expectedShots: [id], fixtures: parity.hash("same-fixture") };
  const manifest: parity.Capture = {
    version: 1,
    source: { head: "synthetic", dirty: [] },
    browser: "test",
    platform: "test",
    contract,
    catalog: parity.hash(JSON.stringify(contract)),
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
        sha256: parity.hash(png),
        width,
        height: 1,
      },
    ],
  };
  await writeFile(path.join(directory, `${id}.png`), png);
  await saveManifest({ directory, manifest });
  return { directory, manifest };
}

it("links comparison images in directories with URL delimiters", async () => {
  const a = await fixture(0),
    b = await fixture(0);
  const parent = temporary.make("parity-paths-");
  const before = path.join(parent, "before #1"),
    after = path.join(parent, "after?2%");
  await rename(a.directory, before);
  await rename(b.directory, after);
  const comparisonDir = await compare(before, after, 0);
  const index = path.join(comparisonDir, "index.html");
  const html = await htmlAt(comparisonDir);
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

it("accepts one-level noise but fails two-level RGBA changes", async () => {
  const baseline = [128, 128, 128, 128];
  const a = await fixture(baseline);
  for (const delta of [-1, 1, -2, 2]) {
    const b = await fixture(baseline.map((value, index) => value + (index === 0 ? delta : 0)));
    const noise = Math.abs(delta) === 1;
    const output = await compare(a.directory, b.directory, noise ? 0 : 1);
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    expect(report).toMatchObject({
      maxRasterNoiseChannelDelta: 1,
      rasterNoisePixels: noise ? 1 : 0,
      results: [{ changedPixels: noise ? 0 : 1, rasterNoisePixels: noise ? 1 : 0 }],
    });
    expect(await htmlAt(output)).toContain(`raster noise (≤1 level): ${noise ? 1 : 0} px`);
  }
});

it.each([
  ["route-apps--mobile-light", true],
  ["route-apps--desktop-light", false],
] as const)(
  "reports pixel differences for %s with only exact known exceptions",
  async (id, known) => {
    const a = await fixture(0, 1, id),
      b = await fixture(37, 1, id);
    await parity.writeGallery(a.directory, a.manifest);
    expect((await htmlAt(a.directory)).includes("Known nondeterministic:")).toBe(known);
    const output = await compare(a.directory, b.directory, known ? 0 : 1);
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    expect(report).toMatchObject({
      changed: known ? 0 : 1,
      knownNondeterministic: known ? 1 : 0,
      results: [
        {
          status: known ? "known-nondeterministic" : "pixels",
          changedPixels: 1,
          rasterNoisePixels: 0,
          diff: `${id}.png`,
        },
      ],
    });
    expect(await htmlAt(output)).toContain(
      known ? "Image clipping paints differently" : `${id}: pixels`,
    );
    expect(await readFile(path.join(output, `${id}.png`))).not.toHaveLength(0);
  },
);

it("fails changed dimensions even for known nondeterministic shots", async () => {
  const id = "route-apps--mobile-light";
  const a = await fixture(0, 1, id),
    b = await fixture(0, 2, id);
  expect(
    await parity.compareCaptures(a.directory, b.directory, temporary.make("parity-output-")),
  ).toBe(1);
});

it.each<[string, (manifest: parity.Capture) => void]>([
  ["metadata", (m) => Object.assign(m, { browser: "" })],
  [
    "missing-shot",
    (m) => {
      m.contract.expectedShots.push("other--profile");
      m.catalog = parity.hash(JSON.stringify(m.contract));
    },
  ],
  ["incomplete", (m) => Object.assign(m, { complete: false })],
  ["duplicate", (m) => m.shots.push(m.shots[0]!)],
  ["unsafe-path", (m) => Object.assign(m.shots[0]!, { file: "../outside.png" })],
  ["checksum", (m) => Object.assign(m.shots[0]!, { sha256: parity.hash("changed-file") })],
])("rejects %s evidence", async (_defect, corrupt) => {
  const a = await fixture(0),
    b = await fixture(0);
  corrupt(b.manifest);
  await saveManifest(b);
  await expect(
    parity.compareCaptures(a.directory, b.directory, temporary.make("parity-output-")),
  ).rejects.toThrow();
});

it("rejects incompatible browser metadata even with identical images", async () => {
  const a = await fixture(0),
    b = await fixture(0);
  b.manifest.browser = "another-browser";
  await saveManifest(b);
  expect(
    await parity.compareCaptures(a.directory, b.directory, temporary.make("parity-output-")),
  ).toBe(1);
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
