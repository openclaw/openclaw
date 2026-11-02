import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { toBuffer } = vi.hoisted(() => ({ toBuffer: vi.fn() }));
const png = Buffer.from("fakepng");

vi.mock("./qr-runtime.ts", () => ({
  loadQrCodeRuntime: async () => ({ toBuffer }),
}));

let qr: typeof import("./qr-image.ts");

beforeAll(async () => {
  vi.resetModules();
  qr = await import("./qr-image.ts");
});

beforeEach(() => {
  toBuffer.mockReset().mockResolvedValue(png);
});

it.each([
  [undefined, { margin: 4, scale: 6 }],
  [
    { scale: 8.9, marginModules: 2.9 },
    { margin: 2, scale: 8 },
  ],
])("renders PNG with normalized options %j", async (options, expected) => {
  await expect(qr.renderQrPngBase64("openclaw", options)).resolves.toBe(png.toString("base64"));
  expect(toBuffer).toHaveBeenCalledWith("openclaw", expected);
});

it.each([
  ["scale", 0, 4, "scale must be between 1 and 12."],
  ["scale", 13, 4, "scale must be between 1 and 12."],
  ["scale", Number.NaN, 4, "scale must be a finite number."],
  ["marginModules", 6, -1, "marginModules must be between 0 and 16."],
  ["marginModules", 6, 17, "marginModules must be between 0 and 16."],
  ["marginModules", 6, Number.POSITIVE_INFINITY, "marginModules must be a finite number."],
])("rejects invalid %s values", async (_name, scale, marginModules, message) => {
  await expect(qr.renderQrPngBase64("openclaw", { scale, marginModules })).rejects.toThrow(message);
  expect(toBuffer).not.toHaveBeenCalled();
});

it("formats QR PNG data URLs", async () => {
  await expect(qr.renderQrPngDataUrl("openclaw")).resolves.toBe(
    `data:image/png;base64,${png.toString("base64")}`,
  );
});

it("writes QR PNGs to a scoped temp file", async ({ onTestFinished }) => {
  using sync = vi.spyOn(syncFs, "fsyncSync");
  const tmpRoot = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-qr-image-");

  const result = await qr.writeQrPngTempFile("openclaw", {
    tmpRoot,
    dirPrefix: "pair-",
    fileName: "pair-qr.png",
  });

  expect(path.basename(result.filePath)).toBe("pair-qr.png");
  expect(path.basename(result.dirPath)).toMatch(/^pair-/);
  expect(result.mediaLocalRoots).toEqual([result.dirPath]);
  await expect(fs.readFile(result.filePath, "utf8")).resolves.toBe("fakepng");
  expect(sync).not.toHaveBeenCalled();
});

it.each([
  ["dirPrefix", { dirPrefix: "../pair-", fileName: "qr.png" }],
  ["fileName", { dirPrefix: "pair-", fileName: "../qr.png" }],
])("rejects pathful QR temp %s values", async (name, opts) => {
  await expect(
    qr.writeQrPngTempFile("openclaw", { tmpRoot: os.tmpdir(), ...opts }),
  ).rejects.toThrow(`${name} must be a non-empty filename segment.`);
  expect(toBuffer).not.toHaveBeenCalled();
});
afterAll(() => {
  vi.doUnmock("./qr-runtime.ts");
  vi.resetModules();
});
