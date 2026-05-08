import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { CaptureBlobRecord } from "./types.js";

export function encodeCaptureBlob(params: {
  data: Buffer;
  contentType?: string;
}): CaptureBlobRecord & { encodedData: Buffer } {
  const sha256 = createHash("sha256").update(params.data).digest("hex");
  const blobId = sha256.slice(0, 24);
  return {
    blobId,
    path: `sqlite:${blobId}`,
    encoding: "gzip",
    sizeBytes: params.data.byteLength,
    sha256,
    encodedData: gzipSync(params.data),
    ...(params.contentType ? { contentType: params.contentType } : {}),
  };
}

export function decodeCaptureBlobText(data: Buffer): string {
  return gunzipSync(data).toString("utf8");
}
