import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { ArtifactSummary } from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { resolveByteResponse } from "./http-byte-range.js";
import { type ArtifactRecord, toArtifactSummary } from "./server-methods/artifacts-content.js";

export type PreparedArtifactDownload = {
  artifact: ArtifactSummary;
  digest: string;
};

export type ArtifactDownloadResponseRequest = {
  expectedDigest: string;
  method: "GET" | "HEAD";
  headers: Partial<Pick<IncomingHttpHeaders, "range" | "if-range" | "if-none-match">>;
};

export type ArtifactDownloadResponse = {
  artifact: ArtifactSummary;
  response: ReturnType<typeof resolveByteResponse>;
  body?: Uint8Array<ArrayBuffer>;
};

function artifactContentDigest(artifact: ArtifactRecord): string {
  return createHash("sha256")
    .update(JSON.stringify([artifact.id, artifact.type, artifact.title, artifact.mimeType]))
    .update("\0")
    .update(artifact.data ?? "")
    .digest("hex");
}

/** Artifact extraction owns base64 validation and normalization before preparation. */
export function prepareArtifactDownload(
  artifact: ArtifactRecord,
): PreparedArtifactDownload | undefined {
  if (artifact.download.mode !== "bytes" || artifact.data === undefined) {
    return undefined;
  }
  return {
    artifact: toArtifactSummary(artifact),
    digest: artifactContentDigest(artifact),
  };
}

export function prepareArtifactDownloadResponse(
  artifact: ArtifactRecord,
  request: ArtifactDownloadResponseRequest,
): ArtifactDownloadResponse | undefined {
  if (
    artifact.download.mode !== "bytes" ||
    artifact.data === undefined ||
    artifactContentDigest(artifact) !== request.expectedDigest
  ) {
    return undefined;
  }
  const response = resolveByteResponse({
    file: { size: Buffer.byteLength(artifact.data, "base64") },
    method: request.method,
    request: { headers: request.headers, headersDistinct: {} },
  });
  const result = { artifact: toArtifactSummary(artifact), response };
  if (
    request.method === "HEAD" ||
    response.kind === "not-modified" ||
    response.kind === "unsatisfiable"
  ) {
    return result;
  }
  const body = new Uint8Array(response.contentLength);
  if (response.kind === "partial") {
    // Decode complete base64 quanta, then copy only the requested bytes for transfer.
    const encodedStart = Math.floor(response.range.start / 3) * 4;
    const encodedEnd = Math.ceil((response.range.end + 1) / 3) * 4;
    const window = Buffer.from(artifact.data.slice(encodedStart, encodedEnd), "base64");
    const offset = response.range.start % 3;
    body.set(window.subarray(offset, offset + body.length));
  } else {
    // Decode into the exact owned allocation instead of returning a pooled Buffer view.
    Buffer.from(body.buffer).write(artifact.data, "base64");
  }
  return { ...result, body };
}
