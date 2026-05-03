import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getImageMetadata,
  MAX_IMAGE_INPUT_PIXELS,
  resizeToJpeg,
  resizeToPng,
  resolveImageOpsWorkerMaxOutputBytes,
  resolveImageOpsWorkerTimeoutMs,
} from "./image-ops.js";
import { createPngBufferWithDimensions } from "./test-helpers.js";

describe("image input pixel guard", () => {
  const oversizedPng = createPngBufferWithDimensions({ width: 8_000, height: 4_000 });
  const overflowedPng = createPngBufferWithDimensions({
    width: 4_294_967_295,
    height: 4_294_967_295,
  });
  const smallPng = createPngBufferWithDimensions({ width: 32, height: 32 });
  const originalBackend = process.env.OPENCLAW_IMAGE_BACKEND;
  const originalWorkerPath = process.env.OPENCLAW_IMAGE_OPS_WORKER_PATH;
  const originalWorkerEnabled = process.env.OPENCLAW_IMAGE_WORKER;
  const originalWorkerTimeout = process.env.OPENCLAW_IMAGE_WORKER_TIMEOUT_MS;

  afterEach(() => {
    restoreEnv("OPENCLAW_IMAGE_BACKEND", originalBackend);
    restoreEnv("OPENCLAW_IMAGE_OPS_WORKER_PATH", originalWorkerPath);
    restoreEnv("OPENCLAW_IMAGE_WORKER", originalWorkerEnabled);
    restoreEnv("OPENCLAW_IMAGE_WORKER_TIMEOUT_MS", originalWorkerTimeout);
  });

  function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it("returns null metadata for images above the pixel limit", async () => {
    await expect(getImageMetadata(oversizedPng)).resolves.toBeNull();
    expect(8_000 * 4_000).toBeGreaterThan(MAX_IMAGE_INPUT_PIXELS);
  });

  it("rejects oversized images before resize work starts", async () => {
    await expect(
      resizeToJpeg({
        buffer: oversizedPng,
        maxSide: 2_048,
        quality: 80,
      }),
    ).rejects.toThrow(/pixel input limit/i);
  });

  it("rejects overflowed pixel counts before resize work starts", async () => {
    await expect(
      resizeToJpeg({
        buffer: overflowedPng,
        maxSide: 2_048,
        quality: 80,
      }),
    ).rejects.toThrow(/pixel input limit/i);
  });

  it("fails closed when sips cannot determine image dimensions", async () => {
    const previousBackend = process.env.OPENCLAW_IMAGE_BACKEND;
    process.env.OPENCLAW_IMAGE_BACKEND = "sips";
    try {
      await expect(
        resizeToJpeg({
          buffer: Buffer.from("not-an-image"),
          maxSide: 2_048,
          quality: 80,
        }),
      ).rejects.toThrow(/unable to determine image dimensions/i);
    } finally {
      if (previousBackend === undefined) {
        delete process.env.OPENCLAW_IMAGE_BACKEND;
      } else {
        process.env.OPENCLAW_IMAGE_BACKEND = previousBackend;
      }
    }
  });

  it("routes sharp-backed PNG resizing through the image worker", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-img-worker-test-"));
    try {
      const workerPath = path.join(dir, "fake-image-worker.mjs");
      await fs.writeFile(
        workerPath,
        [
          "import fs from 'node:fs/promises';",
          "let input = '';",
          "for await (const chunk of process.stdin) input += chunk;",
          "const request = JSON.parse(input);",
          "await fs.writeFile(request.outputPath, Buffer.from('worker-output'));",
          "process.stdout.write(JSON.stringify({ ok: true }));",
        ].join("\n"),
      );
      process.env.OPENCLAW_IMAGE_BACKEND = "sharp";
      process.env.OPENCLAW_IMAGE_OPS_WORKER_PATH = workerPath;
      process.env.OPENCLAW_IMAGE_WORKER = "1";

      await expect(
        resizeToPng({
          buffer: smallPng,
          maxSide: 16,
        }),
      ).resolves.toEqual(Buffer.from("worker-output"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the image worker times out", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-img-worker-timeout-test-"));
    try {
      const workerPath = path.join(dir, "hung-image-worker.mjs");
      await fs.writeFile(workerPath, "setInterval(() => {}, 1000);\n");
      process.env.OPENCLAW_IMAGE_BACKEND = "sharp";
      process.env.OPENCLAW_IMAGE_OPS_WORKER_PATH = workerPath;
      process.env.OPENCLAW_IMAGE_WORKER = "1";
      process.env.OPENCLAW_IMAGE_WORKER_TIMEOUT_MS = "100";

      await expect(
        resizeToPng({
          buffer: smallPng,
          maxSide: 16,
        }),
      ).rejects.toThrow(/image worker timed out/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes the image worker timeout setting", () => {
    expect(resolveImageOpsWorkerTimeoutMs({ OPENCLAW_IMAGE_WORKER_TIMEOUT_MS: "42" })).toBe(42);
    expect(resolveImageOpsWorkerTimeoutMs({ OPENCLAW_IMAGE_WORKER_TIMEOUT_MS: "0" })).toBe(30_000);
  });

  it("normalizes the image worker output limit setting", () => {
    expect(
      resolveImageOpsWorkerMaxOutputBytes({ OPENCLAW_IMAGE_WORKER_MAX_OUTPUT_BYTES: "1024" }),
    ).toBe(1024);
    expect(
      resolveImageOpsWorkerMaxOutputBytes({ OPENCLAW_IMAGE_WORKER_MAX_OUTPUT_BYTES: "0" }),
    ).toBe(64 * 1024 * 1024);
  });
});
