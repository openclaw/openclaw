import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveCliName } from "./cli-name.js";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  resolveTempPathParts,
} from "./nodes-media-utils.js";

const MAX_CAMERA_URL_DOWNLOAD_BYTES = 250 * 1024 * 1024;

export type CameraFacing = "front" | "back";

export type CameraSnapPayload = {
  format: string;
  base64?: string;
  url?: string;
  width: number;
  height: number;
};

export type CameraClipPayload = {
  format: string;
  base64?: string;
  url?: string;
  durationMs: number;
  hasAudio: boolean;
};

export function parseCameraSnapPayload(value: unknown): CameraSnapPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  const url = asString(obj.url);
  const width = asNumber(obj.width);
  const height = asNumber(obj.height);
  if (!format || (!base64 && !url) || width === undefined || height === undefined) {
    throw new Error("invalid camera.snap payload");
  }
  return { format, ...(base64 ? { base64 } : {}), ...(url ? { url } : {}), width, height };
}

export function parseCameraClipPayload(value: unknown): CameraClipPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  const url = asString(obj.url);
  const durationMs = asNumber(obj.durationMs);
  const hasAudio = asBoolean(obj.hasAudio);
  if (!format || (!base64 && !url) || durationMs === undefined || hasAudio === undefined) {
    throw new Error("invalid camera.clip payload");
  }
  return { format, ...(base64 ? { base64 } : {}), ...(url ? { url } : {}), durationMs, hasAudio };
}

export function cameraTempPath(opts: {
  kind: "snap" | "clip";
  facing?: CameraFacing;
  ext: string;
  tmpDir?: string;
  id?: string;
}) {
  const { tmpDir, id, ext } = resolveTempPathParts({
    tmpDir: opts.tmpDir,
    id: opts.id,
    ext: opts.ext,
  });
  const facingPart = opts.facing ? `-${opts.facing}` : "";
  const cliName = resolveCliName();
  return path.join(tmpDir, `${cliName}-camera-${opts.kind}${facingPart}-${id}${ext}`);
}

export async function writeUrlToFile(filePath: string, url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`writeUrlToFile: only https URLs are allowed, got ${parsed.protocol}`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`);
  }

  const contentLengthRaw = res.headers.get("content-length");
  const contentLength = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : undefined;
  if (
    typeof contentLength === "number" &&
    Number.isFinite(contentLength) &&
    contentLength > MAX_CAMERA_URL_DOWNLOAD_BYTES
  ) {
    throw new Error(
      `writeUrlToFile: content-length ${contentLength} exceeds max ${MAX_CAMERA_URL_DOWNLOAD_BYTES}`,
    );
  }

  const body = res.body;
  if (!body) {
    throw new Error(`failed to download ${url}: empty response body`);
  }

  const fileHandle = await fs.open(filePath, "w");
  let bytes = 0;
  let thrown: unknown;
  try {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      bytes += value.byteLength;
      if (bytes > MAX_CAMERA_URL_DOWNLOAD_BYTES) {
        throw new Error(
          `writeUrlToFile: downloaded ${bytes} bytes, exceeds max ${MAX_CAMERA_URL_DOWNLOAD_BYTES}`,
        );
      }
      await fileHandle.write(value);
    }
  } catch (err) {
    thrown = err;
  } finally {
    await fileHandle.close();
  }

  if (thrown) {
    await fs.unlink(filePath).catch(() => {});
    throw thrown;
  }

  return { path: filePath, bytes };
}

export async function writeBase64ToFile(filePath: string, base64: string) {
  const buf = Buffer.from(base64, "base64");
  await fs.writeFile(filePath, buf);
  return { path: filePath, bytes: buf.length };
}

export async function writeCameraClipPayloadToFile(params: {
  payload: CameraClipPayload;
  facing: CameraFacing;
  tmpDir?: string;
  id?: string;
}): Promise<string> {
  const filePath = cameraTempPath({
    kind: "clip",
    facing: params.facing,
    ext: params.payload.format,
    tmpDir: params.tmpDir,
    id: params.id,
  });
  if (params.payload.url) {
    await writeUrlToFile(filePath, params.payload.url);
  } else if (params.payload.base64) {
    await writeBase64ToFile(filePath, params.payload.base64);
  } else {
    throw new Error("invalid camera.clip payload");
  }
  return filePath;
}
