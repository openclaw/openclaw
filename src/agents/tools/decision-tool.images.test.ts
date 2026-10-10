import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadDecisionImages } from "./decision-tool.images.js";
import { ONE_PIXEL_PNG_B64 } from "./image-tool.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("loads a local image as bounded bytes without passing its path to a provider", async () => {
  const root = tempDirs.make("decision-images-");
  const imagePath = path.join(root, "screen.png");
  const bytes = Buffer.from(ONE_PIXEL_PNG_B64, "base64");
  fs.writeFileSync(imagePath, bytes);
  const images = await loadDecisionImages({
    paths: [imagePath],
    fsPolicy: { workspaceOnly: true, root },
    signal: new AbortController().signal,
  });
  expect(images).toEqual([{ mimeType: "image/png", data: Uint8Array.from(bytes) }]);
  expect(JSON.stringify(images)).not.toContain(imagePath);
});

it("rejects an oversized original even when its pixels would compress below the byte limit", async () => {
  const root = tempDirs.make("decision-images-oversized-");
  const imagePath = path.join(root, "screen.png");
  const bytes = Buffer.alloc(4 * 1_048_576 + 1);
  createSolidPngBuffer(32, 16, { r: 12, g: 34, b: 56 }).copy(bytes);
  fs.writeFileSync(imagePath, bytes);
  await expect(
    loadDecisionImages({
      paths: [imagePath],
      fsPolicy: { workspaceOnly: true, root },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
});

it("rejects remote references and symlink escapes before a provider can receive bytes", async () => {
  const root = tempDirs.make("decision-images-root-");
  const outside = tempDirs.make("decision-images-outside-");
  const outsideImage = path.join(outside, "screen.png");
  fs.writeFileSync(outsideImage, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
  const linked = path.join(root, "linked.png");
  fs.symlinkSync(outsideImage, linked);
  const fetch = vi.spyOn(globalThis, "fetch");
  const settings = {
    fsPolicy: { workspaceOnly: true, root },
    signal: new AbortController().signal,
  };
  await expect(
    loadDecisionImages({ ...settings, paths: ["https://example.test/screen.png"] }),
  ).rejects.toThrow("local image paths");
  await expect(
    loadDecisionImages({ ...settings, paths: ["@https://example.test/screen.png"] }),
  ).rejects.toThrow("local image paths");
  expect(fetch).not.toHaveBeenCalled();
  await expect(loadDecisionImages({ ...settings, paths: [linked] })).rejects.toThrow();
  fetch.mockRestore();
});
