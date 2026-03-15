import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCliName } from "./cli-name.js";

export type CameraFacing = "front" | "back";

export type CameraSnapPayload = {
  format: string;
  base64: string;
  width: number;
  height: number;
};

export type CameraClipPayload = {
  format: string;
  base64: string;
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
  const width = asNumber(obj.width);
  const height = asNumber(obj.height);
  if (!format || !base64 || width === undefined || height === undefined) {
    throw new Error("invalid camera.snap payload");
  }
  return { format, base64, width, height };
}

export function parseCameraClipPayload(value: unknown): CameraClipPayload {
  const obj = asRecord(value);
  const format = asString(obj.format);
  const base64 = asString(obj.base64);
  const durationMs = asNumber(obj.durationMs);
  const hasAudio = asBoolean(obj.hasAudio);
  if (!format || !base64 || durationMs === undefined || hasAudio === undefined) {
    throw new Error("invalid camera.clip payload");
  }
  return { format, base64, durationMs, hasAudio };
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

export async function writeUrlToFile(
  filePath: string,
  url: string,
  opts: { expectedHost: string },
) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`writeUrlToFile: only https URLs are allowed, got ${parsed.protocol}`);
  }
  const expectedHost = normalizeHostname(opts.expectedHost);
  if (!expectedHost) {
    throw new Error("writeUrlToFile: expectedHost is required");
  }
  if (normalizeHostname(parsed.hostname) !== expectedHost) {
    throw new Error(
      `writeUrlToFile: url host ${parsed.hostname} must match node host ${opts.expectedHost}`,
    );
  }

  // Allow private networks: nodes commonly serve camera feeds from LAN IPs.
  // SSRF to other hosts is blocked by hostnameAllowlist + hostname equality checks.
  const policy = {
    allowPrivateNetwork: true,
    hostnameAllowlist: [expectedHost],
  };

  let release: () => Promise<void> = async () => {};
  let bytes = 0;
  try {
    const guarded = await fetchWithSsrFGuard({
      url,
      auditContext: "writeUrlToFile",
      policy,
    });
    release = guarded.release;
    const finalUrl = new URL(guarded.finalUrl);
    if (finalUrl.protocol !== "https:") {
      throw new Error(`writeUrlToFile: redirect resolved to non-https URL ${guarded.finalUrl}`);
    }
    if (normalizeHostname(finalUrl.hostname) !== expectedHost) {
      throw new Error(
        `writeUrlToFile: redirect host ${finalUrl.hostname} must match node host ${opts.expectedHost}`,
      );
    }
    const res = guarded.response;
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
  } finally {
    await release();
  }

  return { path: filePath, bytes };
}

export async function writeBase64ToFile(filePath: string, base64: string) {
  const buf = Buffer.from(base64, "base64");
  await fs.writeFile(filePath, buf);
  return { path: filePath, bytes: buf.length };
}
