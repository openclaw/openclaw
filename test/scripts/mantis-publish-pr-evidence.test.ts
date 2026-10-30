import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadEvidenceManifest,
  publishArtifactFiles,
  renderEvidenceComment,
} from "../../scripts/mantis/publish-pr-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const storageConfig = {
  accessKeyId: "access",
  bucket: "qa-artifacts",
  endpoint: "https://example.r2.cloudflarestorage.com",
  publicBaseUrl: "https://qa.openclaw.ai",
  region: "auto",
  secretAccessKey: "secret",
};
const artifactRoot = "mantis/discord/pr-1/run-1";
const rawBase = `https://qa.openclaw.ai/${artifactRoot}`;
const marker = "<!-- mantis-discord-status-reactions -->";
type ArtifactFetch = NonNullable<Parameters<typeof publishArtifactFiles>[0]["fetchImpl"]>;
function render(manifest: ReturnType<typeof loadEvidenceManifest>) {
  return renderEvidenceComment({ manifest, marker, rawBase });
}
function contains(body: string, ...parts: string[]) {
  for (const part of parts) {
    expect(body).toContain(part);
  }
}
function upload(fetchImpl: ArtifactFetch, timeoutMs?: number) {
  return publishArtifactFiles({
    artifactRoot,
    fetchImpl,
    storageConfig,
    timeoutMs,
    manifest: loadEvidenceManifest(writeFixtureManifest()),
  });
}
function writeManifest(manifest: object = {}, files: string[] = []) {
  const dir = tempDirs.make("mantis-evidence-test-");
  for (const name of files) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), name);
  }
  const file = path.join(dir, "mantis-evidence.json");
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 2,
      id: "discord-status-reactions",
      title: "Mantis Discord Status Reactions QA",
      scenario: "discord-status-reactions-tool-only",
      comparison: { candidate: lane("artifact path is contained", "bbb", "pass"), pass: true },
      ...manifest,
    }),
  );
  return file;
}
function lane(expected: string, sha: string, status: string, expectationMet = true) {
  return { expected, sha, status, expectationMet };
}
function timeline(laneName: string) {
  return {
    kind: "timeline",
    lane: laneName,
    label: laneName,
    path: `${laneName}/timeline.png`,
    targetPath: `${laneName}.png`,
  };
}
const fixtureArtifacts = [
  timeline("baseline"),
  timeline("candidate"),
  {
    kind: "motionClip",
    path: "baseline/change.mp4",
    targetPath: "baseline-change.mp4",
    label: "Baseline change MP4",
  },
];
function writeFixtureManifest() {
  return writeManifest(
    {
      summary: "Mantis reran the scenario.",
      comparison: {
        baseline: lane("queued-only", "aaa", "fail"),
        candidate: { ...lane("queued -> thinking -> done", "bbb", "pass"), digest: "3 messages" },
        differential: "bot messages 2→3 · deletes 1→0",
        pass: true,
      },
      artifacts: fixtureArtifacts,
    },
    fixtureArtifacts.map(({ path: source }) => source),
  );
}

describe("scripts/mantis/publish-pr-evidence", () => {
  it("selects only Mantis-owned status comments", () => {
    const source = readFileSync("scripts/mantis/publish-pr-evidence.mjs", "utf8");

    expect(source).toContain('.user.login == "openclaw-mantis[bot]"');
  });

  it("keeps required booleans for sibling trusted evidence producers", () => {
    const manifestPath = writeManifest({ comparison: { candidate: {}, pass: true } });
    expect(() => loadEvidenceManifest(manifestPath)).toThrow(
      "Mantis evidence comparison.candidate.expectationMet must be a boolean.",
    );
  });

  it("renders a manifest-driven PR comment with inline screenshots and video links", () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const body = renderEvidenceComment({
      manifest,
      marker,
      rawBase,
      artifactUrl: "https://example.test/artifact",
      requestSource: "pull_request",
      runUrl: "https://example.test/run",
      treeUrl: "https://example.test/files",
    });
    contains(
      body,
      marker,
      "- Artifact: https://example.test/artifact",
      "- Trigger: `pull_request`",
      "- Run: https://example.test/run",
      "Raw QA files: https://example.test/files",
      "Summary: Mantis reran the scenario.",
      '<table width="100%">',
      '<th width="50%">baseline</th>',
      '<th width="50%">candidate</th>',
      `<td width="50%" align="center"><img src="${rawBase}/baseline.png" width="100%"`,
      `[Baseline change MP4](${rawBase}/baseline-change.mp4)`,
      "- Baseline: `fail` at `aaa`, expected queued-only",
      "- Candidate (PR merged onto main): `pass` at `bbb` — queued -&gt; thinking -&gt; done · facts: 3 messages",
      "- Differential (trusted facts): bot messages 2→3 · deletes 1→0\n- Overall: `pass`",
    );
    expect(body).not.toContain("raw.githubusercontent.com");
  });

  it("uploads manifest artifacts to R2-compatible object storage", async () => {
    const requests: Array<Parameters<ArtifactFetch>[1] & { url: string }> = [];
    const published = await upload(async (url, init) => {
      requests.push({ ...init, url: url.toString() });
      return new Response("", { status: 200 });
    });

    expect(published).toEqual({ artifactRoot, rawBase, treeUrl: `${rawBase}/index.json` });
    expect(requests.map(({ url }) => url)).toEqual(
      [
        ...fixtureArtifacts.map(({ targetPath }) => targetPath),
        "mantis-evidence.json",
        "index.json",
      ].map(
        (target) => `${storageConfig.endpoint}/${storageConfig.bucket}/${artifactRoot}/${target}`,
      ),
    );
    for (const request of requests) {
      expect(request).toMatchObject({
        method: "PUT",
        signal: expect.any(AbortSignal),
      });
    }
    expect(requests[0]?.headers).toMatchObject({
      "content-type": "image/png",
      "x-amz-date": expect.any(String),
    });
    expect(new Headers(requests[0]?.headers).get("authorization")).toContain("Credential=access/");
    expect(String(requests[4]?.body)).toContain(
      '"url": "https://qa.openclaw.ai/mantis/discord/pr-1/run-1/baseline.png"',
    );
  });

  it("aborts a stalled artifact upload after the per-object timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const pendingUpload = upload((_url, init) => {
      observedSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason as Error), {
          once: true,
        });
      });
    }, 5);

    await expect(pendingUpload).rejects.toMatchObject({
      cause: { name: "TimeoutError" },
      message: "Timed out uploading Mantis artifact baseline.png after 5ms.",
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("bounds oversized non-ok upload error response bodies", async () => {
    const chunk = new Uint8Array(8 * 1024).fill("x".charCodeAt(0));
    let enqueuedBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueuedBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    await expect(
      upload(async () => new Response(body, { status: 503, statusText: "Service Unavailable" })),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Failed to upload Mantis artifact baseline\.png: 503 Service Unavailable\nMantis upload error response body exceeded 65536 bytes$/u,
      ),
    });
    expect(enqueuedBytes).toBeGreaterThan(64 * 1024);
    expect(enqueuedBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it("propagates signal abort during non-ok upload error body reading", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(upload(async () => new Response(body, { status: 503 }), 50)).rejects.toMatchObject(
      {
        cause: { name: "TimeoutError" },
        message: "Timed out uploading Mantis artifact baseline.png after 50ms.",
      },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(cancelled).toBe(true);
  });

  it("reads small non-ok upload error response bodies within the bound", async () => {
    await expect(
      upload(async () => new Response("access denied", { status: 403 })),
    ).rejects.toMatchObject({
      message: "Failed to upload Mantis artifact baseline.png: 403 \naccess denied",
    });
  });

  it("allows failure manifests to omit optional visual artifacts", () => {
    const manifest = loadEvidenceManifest(
      writeManifest({
        comparison: {
          candidate: lane("Slack QA and VM gateway setup pass", "bbb", "fail", false),
          pass: false,
        },
        artifacts: [
          { inline: true, kind: "desktopScreenshot", path: "missing.png", required: false },
        ],
      }),
    );
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
      "mantis-evidence.json",
    ]);
    const body = render(manifest);
    contains(body, "- Overall: `fail`");
    expect(body).not.toContain("<img ");
  });

  it("rejects artifact paths that escape the manifest directory", () => {
    const manifestPath = writeManifest({
      artifacts: [{ kind: "metadata", path: "../outside.json" }],
    });

    expect(() => loadEvidenceManifest(manifestPath)).toThrow(/escapes manifest directory/u);
  });
});
