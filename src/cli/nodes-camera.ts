import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCliName } from "./cli-name.js";

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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

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
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const id = opts.id ?? randomUUID();
  const facingPart = opts.facing ? `-${opts.facing}` : "";
  const ext = opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`;
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
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);
  return { path: filePath, bytes: buf.length };
}

export async function writeBase64ToFile(filePath: string, base64: string) {
  const buf = Buffer.from(base64, "base64");
  await fs.writeFile(filePath, buf);
  return { path: filePath, bytes: buf.length };
}
