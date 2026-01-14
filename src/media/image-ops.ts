import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runExec } from "../process/exec.js";

type Sharp = typeof import("sharp");

export type ImageMetadata = {
  width: number;
  height: number;
};

function isBun(): boolean {
  return typeof (process.versions as { bun?: unknown }).bun === "string";
}

function prefersSips(): boolean {
  return (
    process.env.CLAWDBOT_IMAGE_BACKEND === "sips" ||
    (process.env.CLAWDBOT_IMAGE_BACKEND !== "sharp" && isBun() && process.platform === "darwin")
  );
}

async function loadSharp(): Promise<(buffer: Buffer) => ReturnType<Sharp>> {
  const mod = (await import("sharp")) as unknown as { default?: Sharp };
  const sharp = mod.default ?? (mod as unknown as Sharp);
  return (buffer) => sharp(buffer, { failOnError: false });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-img-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sipsMetadataFromBuffer(buffer: Buffer): Promise<ImageMetadata | null> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.img");
    await fs.writeFile(input, buffer);
    const { stdout } = await runExec(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", input],
      {
        timeoutMs: 10_000,
        maxBuffer: 512 * 1024,
      },
    );
    const w = stdout.match(/pixelWidth:\s*([0-9]+)/);
    const h = stdout.match(/pixelHeight:\s*([0-9]+)/);
    if (!w?.[1] || !h?.[1]) return null;
    const width = Number.parseInt(w[1], 10);
    const height = Number.parseInt(h[1], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  });
}

async function sipsResizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
}): Promise<Buffer> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.img");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, params.buffer);
    await runExec(
      "/usr/bin/sips",
      [
        "-Z",
        String(Math.max(1, Math.round(params.maxSide))),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(Math.max(1, Math.min(100, Math.round(params.quality)))),
        input,
        "--out",
        output,
      ],
      { timeoutMs: 20_000, maxBuffer: 1024 * 1024 },
    );
    return await fs.readFile(output);
  });
}

export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  if (prefersSips()) {
    return await sipsMetadataFromBuffer(buffer).catch(() => null);
  }

  try {
    const sharp = await loadSharp();
    const meta = await sharp(buffer).metadata();
    const width = Number(meta.width ?? 0);
    const height = Number(meta.height ?? 0);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

export async function resizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer> {
  if (prefersSips()) {
    // Avoid enlarging by checking dimensions first (sips has no withoutEnlargement flag).
    if (params.withoutEnlargement !== false) {
      const meta = await getImageMetadata(params.buffer);
      if (meta) {
        const maxDim = Math.max(meta.width, meta.height);
        if (maxDim > 0 && maxDim <= params.maxSide) {
          return await sipsResizeToJpeg({
            buffer: params.buffer,
            maxSide: maxDim,
            quality: params.quality,
          });
        }
      }
    }
    return await sipsResizeToJpeg({
      buffer: params.buffer,
      maxSide: params.maxSide,
      quality: params.quality,
    });
  }

  const sharp = await loadSharp();
  return await sharp(params.buffer)
    .resize({
      width: params.maxSide,
      height: params.maxSide,
      fit: "inside",
      withoutEnlargement: params.withoutEnlargement !== false,
    })
    .jpeg({ quality: params.quality, mozjpeg: true })
    .toBuffer();
}
