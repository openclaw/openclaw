import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeOutputAsset } from "./media-output.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=",
  "base64",
);

it.each([1, 2])(
  "writes %s buffered outputs through the selected physical parent",
  async (count) => {
    const dir = tempDirs.make("media-output-parent-");
    const physical = path.join(dir, "physical");
    await fs.mkdir(path.join(physical, "nested"), { recursive: true });
    const alias = path.join(dir, "selected");
    await fs.symlink(path.join(physical, "nested"), alias, "junction");
    for (let index = 0; index < count; index++) {
      const name = `result${count === 1 ? "" : `-${index + 1}`}.png`;
      const output = await writeOutputAsset({
        buffer: png,
        mimeType: "image/png",
        outputPath: `${alias}${path.sep}..${path.sep}new${path.sep}result.jpg`,
        outputIndex: index,
        outputCount: count,
        subdir: "images",
      });
      expect(output.path).toBe(path.join(physical, "new", name));
      expect(await fs.readFile(output.path)).toEqual(png);
    }
    expect(await fs.stat(path.join(dir, "new")).catch(() => undefined)).toBeUndefined();
  },
);

it("refuses an unreachable parent without replacing an existing output", async () => {
  const dir = tempDirs.make("media-output-unreachable-");
  const output = path.join(dir, "result.png");
  await fs.writeFile(output, "keep-existing");
  await expect(
    writeOutputAsset({
      buffer: png,
      outputPath: `${dir}${path.sep}missing${path.sep}..${path.sep}result.png`,
      outputIndex: 0,
      outputCount: 1,
      subdir: "images",
    }),
  ).rejects.toThrow("Media output traverses a missing directory");
  expect(await fs.readFile(output, "utf8")).toBe("keep-existing");
  expect(await fs.readdir(dir)).toEqual(["result.png"]);
});

it.each([".", ".."])('refuses a final "%s" without changing the output parent', async (suffix) => {
  const dir = tempDirs.make("media-output-final-component-");
  const file = path.join(dir, "plain.png");
  await fs.writeFile(file, "keep-existing");
  await expect(
    writeOutputAsset({
      buffer: png,
      outputPath: `${file}${path.sep}${suffix}`,
      outputIndex: 0,
      outputCount: 1,
      subdir: "images",
    }),
  ).rejects.toThrow("Media output must name a file");
  expect(await fs.readFile(file, "utf8")).toBe("keep-existing");
  expect(await fs.readdir(dir)).toEqual(["plain.png"]);
});
