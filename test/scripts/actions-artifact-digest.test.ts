import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { downloadExactActionsArtifactArchive, verifyExactActionsArtifactDigest } from "../../scripts/lib/actions-artifact-archive.mjs";

function fixture(size = 4, transferredSize = size) {
  const chunk = Buffer.alloc(64 * 1024, 7);
  const hash = createHash("sha256");
  for (let remaining = size; remaining > 0; remaining -= chunk.length) {
    hash.update(chunk.subarray(0, Math.min(remaining, chunk.length)));
  }
  const expected = { repository: "openclaw/openclaw", artifactId: 777, artifactName: "retained-image",
    artifactDigest: `sha256:${hash.digest("hex")}`, artifactSizeBytes: size,
    artifactExpiresAt: "2030-01-01T00:00:00Z", runId: 888, workflowSha: "a".repeat(40) };
  const metadata = { id: 777, name: expected.artifactName, digest: expected.artifactDigest,
    size_in_bytes: size, expires_at: expected.artifactExpiresAt, expired: false,
    workflow_run: { id: 888, head_sha: expected.workflowSha } };
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    if (!String(input).endsWith("/zip")) return Response.json(metadata);
    let remaining = transferredSize;
    return new Response(new ReadableStream({ pull(controller) {
      if (remaining === 0) { controller.close(); return; }
      const length = Math.min(remaining, chunk.length);
      controller.enqueue(chunk.subarray(0, length));
      remaining -= length;
    } }));
  });
  return { expected, metadata, fetchImpl, token: "synthetic-test-token", retryAttempts: 1 };
}

describe("exact artifact streaming digest verification", () => {
  it("hashes the observed 402006833-byte image size without raising buffered ZIP limits", async () => {
    // Reuse one 64 KiB synthetic block: no test or production whole-image allocation.
    const params = fixture(402006833);
    const result = await verifyExactActionsArtifactDigest(params);
    expect(result).toEqual({ digest: params.expected.artifactDigest, artifactMetadata: params.metadata });
    expect(result).not.toHaveProperty("archiveBytes");
    await expect(downloadExactActionsArtifactArchive(params)).rejects.toThrow("configured archive limit");
  });

  it.each([3, 5])("rejects a transfer of %i bytes against exactly four admitted bytes", async (size) => {
    await expect(verifyExactActionsArtifactDigest(fixture(4, size))).rejects.toThrow(
      size < 4 ? "approved byte count" : "exceeded its approved byte count");
  });

  it("rejects changed content even when its exact size and metadata match", async () => {
    const params = fixture();
    params.expected.artifactDigest = `sha256:${"b".repeat(64)}`;
    params.metadata.digest = params.expected.artifactDigest;
    await expect(verifyExactActionsArtifactDigest(params)).rejects.toThrow("does not match");
  });

  it("rejects changed remote identity before reading the binary body", async () => {
    const params = fixture();
    params.metadata.workflow_run.id = 999;
    await expect(verifyExactActionsArtifactDigest(params)).rejects.toThrow("immutable publication tuple");
    expect(params.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
