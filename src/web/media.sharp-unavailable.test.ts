import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { SharpUnavailableError } from "../media/image-ops.js";
import { loadWebMedia } from "./media.js";

// Simulate a host where the sharp native module cannot load (e.g., CPU lacking SSE4.2).
vi.mock("../media/image-ops.js", async () => {
  const actual =
    await vi.importActual<typeof import("../media/image-ops.js")>("../media/image-ops.js");
  return {
    ...actual,
    getImageMetadata: () => Promise.resolve(null),
    isSharpAvailable: () => false,
    hasAlphaChannel: () => Promise.resolve(false),
    resizeToJpeg: () => {
      throw new SharpUnavailableError(new Error("CPU incompatible with sharp"));
    },
    resizeToPng: () => {
      throw new SharpUnavailableError(new Error("CPU incompatible with sharp"));
    },
    optimizeImageToPng: () => {
      throw new SharpUnavailableError(new Error("CPU incompatible with sharp"));
    },
    convertHeicToJpeg: () => {
      throw new SharpUnavailableError(new Error("CPU incompatible with sharp"));
    },
  };
});

let fixtureRoot = "";
// Known-good 1×1 transparent PNG (valid, ~54 decoded bytes).
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=";
let smallPngBuffer: Buffer;
let smallPngFile = "";

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-media-sharp-test-"),
  );
  smallPngBuffer = Buffer.from(TINY_PNG_B64, "base64");
  smallPngFile = path.join(fixtureRoot, "small.png");
  await fs.writeFile(smallPngFile, smallPngBuffer);
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("loadWebMedia when sharp is unavailable", () => {
  it("passes through images already within the byte cap without re-encoding", async () => {
    const cap = 1024 * 1024; // 1 MB — tiny PNG is ~54 bytes
    const result = await loadWebMedia(smallPngFile, cap, { localRoots: [fixtureRoot] });
    expect(result.kind).toBe("image");
    // Buffer must be passed through unchanged (no re-encoding attempt)
    expect(result.buffer.equals(smallPngBuffer)).toBe(true);
    expect(result.buffer.length).toBeLessThanOrEqual(cap);
  });

  it("throws SharpUnavailableError when the image exceeds the cap and resize is required", async () => {
    const cap = 1; // force cap below image size
    await expect(loadWebMedia(smallPngFile, cap, { localRoots: [fixtureRoot] })).rejects.toThrow(
      SharpUnavailableError,
    );
  });
});
