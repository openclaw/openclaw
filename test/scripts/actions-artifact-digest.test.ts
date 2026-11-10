import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadExactActionsArtifactArchive,
  verifyExactActionsArtifactDigest,
} from "../../scripts/lib/actions-artifact-archive.mjs";
import { createReleaseEvidenceReplay } from "../../scripts/lib/release-evidence-replay.mjs";

function fixture(size = 4, transferredSize = size) {
  const chunk = Buffer.alloc(64 * 1024, 7);
  const hash = createHash("sha256");
  for (let remaining = size; remaining > 0; remaining -= chunk.length) {
    hash.update(chunk.subarray(0, Math.min(remaining, chunk.length)));
  }
  const expected = {
    repository: "openclaw/openclaw",
    artifactId: 777,
    artifactName: "retained-image",
    artifactDigest: `sha256:${hash.digest("hex")}`,
    artifactSizeBytes: size,
    artifactExpiresAt: "2030-01-01T00:00:00Z",
    runId: 888,
    workflowSha: "a".repeat(40),
  };
  const metadata = {
    id: 777,
    name: expected.artifactName,
    digest: expected.artifactDigest,
    size_in_bytes: size,
    expires_at: expected.artifactExpiresAt,
    expired: false,
    workflow_run: { id: 888, head_sha: expected.workflowSha },
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    if (!(input instanceof Request ? input.url : String(input)).endsWith("/zip")) {
      return Response.json(metadata);
    }
    let remaining = transferredSize;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (remaining === 0) {
            controller.close();
            return;
          }
          const length = Math.min(remaining, chunk.length);
          controller.enqueue(chunk.subarray(0, length));
          remaining -= length;
        },
      }),
    );
  });
  return { expected, metadata, fetchImpl, token: "synthetic-test-token", retryAttempts: 1 };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("exact artifact streaming digest verification", () => {
  it.each([
    { archiveTimeoutMs: undefined, delayMs: 70_000, succeeds: false, elapsedMs: 60_000 },
    { archiveTimeoutMs: 240_000, delayMs: 70_000, succeeds: true, elapsedMs: 70_000 },
    { archiveTimeoutMs: 240_000, delayMs: 250_000, succeeds: false, elapsedMs: 240_000 },
  ])("bounds delayed archive bodies: $archiveTimeoutMs / $delayMs", async (scenario) => {
    vi.useFakeTimers();
    const timeouts: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const params = fixture();
    const started = Date.now();
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith("/zip")) {
        return Response.json(params.metadata);
      }
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            const timer = setTimeout(() => {
              controller.enqueue(Buffer.alloc(4, 7));
              controller.close();
            }, scenario.delayMs);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
        }),
      );
    };
    const verification = verifyExactActionsArtifactDigest({
      ...params,
      fetchImpl,
      archiveTimeoutMs: scenario.archiveTimeoutMs,
    });
    const checked = scenario.succeeds
      ? expect(verification).resolves.toMatchObject({ digest: params.expected.artifactDigest })
      : expect(verification).rejects.toThrow(/Timed out|deadline exceeded/);
    await vi.advanceTimersByTimeAsync(scenario.elapsedMs);
    await checked;
    expect(Date.now() - started).toBe(scenario.elapsedMs);
    expect(timeouts).toEqual([60_000, scenario.archiveTimeoutMs ?? 60_000]);
  });

  it("rejects archive request budgets beyond the existing four-minute ceiling", async () => {
    await expect(
      verifyExactActionsArtifactDigest({ ...fixture(), archiveTimeoutMs: 240_001 }),
    ).rejects.toThrow("no larger than 240000");
  });

  it("hashes the observed 402006833-byte image size without raising buffered ZIP limits", async () => {
    // Reuse one 64 KiB synthetic block: no test or production whole-image allocation.
    const params = fixture(402006833);
    const result = await verifyExactActionsArtifactDigest(params);
    expect(result).toEqual({
      digest: params.expected.artifactDigest,
      artifactMetadata: params.metadata,
    });
    expect(result).not.toHaveProperty("archiveBytes");
    await expect(downloadExactActionsArtifactArchive(params)).rejects.toThrow(
      "configured archive limit",
    );
  });

  it.each([3, 5])(
    "rejects a transfer of %i bytes against exactly four admitted bytes",
    async (size) => {
      await expect(verifyExactActionsArtifactDigest(fixture(4, size))).rejects.toThrow(
        size < 4 ? "approved byte count" : "exceeded its approved byte count",
      );
    },
  );

  it("rejects changed content even when its exact size and metadata match", async () => {
    const params = fixture();
    params.expected.artifactDigest = `sha256:${"b".repeat(64)}`;
    params.metadata.digest = params.expected.artifactDigest;
    await expect(verifyExactActionsArtifactDigest(params)).rejects.toThrow("does not match");
  });

  it("replays archive bytes but retains live metadata and selected-digest checks", async () => {
    const params = fixture();
    const binding = { publication: "archive-boundary-fixture" };
    const preview = createReleaseEvidenceReplay(binding);
    await downloadExactActionsArtifactArchive({ ...params, immutableReads: preview });
    const payload = JSON.parse(preview.serialize());
    params.fetchImpl.mockClear();
    const replay = () => createReleaseEvidenceReplay(binding, payload);
    const result = await downloadExactActionsArtifactArchive({ ...params, immutableReads: replay() });
    expect(result.archiveBytes).toEqual(Buffer.alloc(4, 7));
    expect(params.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/openclaw/openclaw/actions/artifacts/777",
    ]);

    params.metadata.expired = true;
    await expect(
      downloadExactActionsArtifactArchive({ ...params, immutableReads: replay() }),
    ).rejects.toThrow("immutable publication tuple");
    params.metadata.expired = false;

    // A self-consistent carrier digest is not the selected publication digest.
    const changed = Buffer.alloc(4, 8);
    payload.entries[0][1].data = changed.toString("base64");
    payload.entries[0][1].sha256 = createHash("sha256").update(changed).digest("hex");
    await expect(
      downloadExactActionsArtifactArchive({ ...params, immutableReads: replay() }),
    ).rejects.toThrow(/does not match/iu);
    expect(params.fetchImpl.mock.calls.every(([url]) => !String(url).endsWith("/zip"))).toBe(true);
  });

  it("rejects changed remote identity before reading the binary body", async () => {
    const params = fixture();
    params.metadata.workflow_run.id = 999;
    await expect(verifyExactActionsArtifactDigest(params)).rejects.toThrow(
      "immutable publication tuple",
    );
    expect(params.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
