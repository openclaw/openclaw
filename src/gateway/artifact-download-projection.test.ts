import { describe, expect, it } from "vitest";
import {
  prepareArtifactDownload,
  prepareArtifactDownloadResponse,
} from "./artifact-download-projection.js";
import type { ArtifactRecord } from "./server-methods/artifacts-content.js";

const artifact: ArtifactRecord = {
  id: "artifact_fixture",
  type: "file",
  title: "fixture.bin",
  mimeType: "application/octet-stream",
  sizeBytes: 999,
  download: { mode: "bytes" },
  data: "AAECAwQFBgcICQoLDA==",
};

function request(input: Parameters<typeof prepareArtifactDownloadResponse>[1]) {
  const result = prepareArtifactDownloadResponse(artifact, input);
  expect(result).toBeDefined();
  return result!;
}

const expectedDigest = prepareArtifactDownload(artifact)!.digest;

describe("artifact download byte projection", () => {
  it.each([
    { range: "bytes=0-0", expected: [0] },
    { range: "bytes=1-4", expected: [1, 2, 3, 4] },
    { range: "bytes=2-5", expected: [2, 3, 4, 5] },
    { range: "bytes=10-12", expected: [10, 11, 12] },
    { range: "bytes=11-12", expected: [11, 12] },
    { range: "bytes=12-12", expected: [12] },
  ])("returns only independently owned bytes for $range", ({ range, expected }) => {
    const result = request({ expectedDigest, method: "GET", headers: { range } });
    expect(result.response).toMatchObject({
      kind: "partial",
      contentLength: expected.length,
      size: 13,
    });
    expect(Array.from(result.body!)).toEqual(expected);
    expect(result.body!.byteOffset).toBe(0);
    expect(result.body!.buffer.byteLength).toBe(expected.length);
    const transferred = structuredClone(result.body, { transfer: [result.body!.buffer] });
    expect(Array.from(transferred!)).toEqual(expected);
    expect(result.body!.buffer.byteLength).toBe(0);
  });

  it("sizes and transfers a full representation using the payload rather than declared size", () => {
    const prepared = prepareArtifactDownload(artifact)!;
    expect(prepared.artifact).not.toHaveProperty("data");
    const result = request({ expectedDigest, method: "GET", headers: {} });
    expect(result.response).toMatchObject({ kind: "full", contentLength: 13 });
    expect(Array.from(result.body!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result.body!.buffer.byteLength).toBe(13);
    const transferred = structuredClone(result.body, { transfer: [result.body!.buffer] });
    expect(transferred!.byteLength).toBe(13);
    expect(result.body!.buffer.byteLength).toBe(0);
  });

  it.each([
    { method: "HEAD", headers: { range: "bytes=1-4" }, kind: "full" },
    { method: "GET", headers: { "if-none-match": "*" }, kind: "not-modified" },
    { method: "GET", headers: { range: "bytes=13-" }, kind: "unsatisfiable" },
  ] as const)("returns no payload for $method/$kind", ({ method, headers, kind }) => {
    const input = { expectedDigest, method, headers };
    const result = request(input);
    expect(result.response.kind).toBe(kind);
    expect(result).not.toHaveProperty("body");
    expect(
      prepareArtifactDownloadResponse({ ...artifact, data: "AQECAwQFBgcICQoLDA==" }, input),
    ).toBeUndefined();
  });
});
