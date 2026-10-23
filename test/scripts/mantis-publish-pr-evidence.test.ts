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
const links = {
  artifactUrl: "https://github.com/openclaw/openclaw/actions/runs/1/artifacts/2",
  requestSource: "workflow_dispatch",
  runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
  treeUrl: rawBase,
};
function render(
  manifest: ReturnType<typeof loadEvidenceManifest>,
  options: Partial<Parameters<typeof renderEvidenceComment>[0]> = {},
) {
  return renderEvidenceComment({
    manifest,
    marker,
    rawBase,
    ...options,
  });
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
function writeManifest(dir: string, manifest: object) {
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
function timeline(laneName: string, label: string, alt: string) {
  return {
    kind: "timeline",
    lane: laneName,
    label,
    alt,
    path: `${laneName}/timeline.png`,
    targetPath: `${laneName}.png`,
  };
}
function runArtifact(kind: string, file: string, label: string) {
  return { kind, lane: "run", path: file, targetPath: file, label };
}

function writeFixtureManifest() {
  const dir = tempDirs.make("mantis-evidence-test-");
  mkdirSync(path.join(dir, "baseline"), { recursive: true });
  mkdirSync(path.join(dir, "candidate"), { recursive: true });
  writeFileSync(path.join(dir, "baseline", "timeline.png"), "baseline timeline");
  writeFileSync(path.join(dir, "candidate", "timeline.png"), "candidate timeline");
  writeFileSync(path.join(dir, "baseline", "change.mp4"), "baseline clip");
  return writeManifest(dir, {
    summary: "Mantis reran the scenario.",
    comparison: {
      baseline: lane("queued-only", "aaa", "fail"),
      candidate: lane("queued -> thinking -> done", "bbb", "pass"),
      pass: true,
    },
    artifacts: [
      timeline("baseline", "Baseline queued-only", "Baseline timeline"),
      timeline("candidate", "Candidate queued -> thinking -> done", "Candidate timeline"),
      {
        kind: "motionClip",
        lane: "baseline",
        path: "baseline/change.mp4",
        targetPath: "baseline-change.mp4",
        label: "Baseline change MP4",
      },
    ],
  });
}

describe("scripts/mantis/publish-pr-evidence", () => {
  it("selects only Mantis-owned status comments", () => {
    const source = readFileSync("scripts/mantis/publish-pr-evidence.mjs", "utf8");

    expect(source).toContain('.user.login == "openclaw-mantis[bot]"');
  });

  it("keeps required booleans for sibling trusted evidence producers", () => {
    const manifestPath = writeFixtureManifest();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.comparison.candidate.expectationMet;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => loadEvidenceManifest(manifestPath)).toThrow(
      "Mantis evidence comparison.candidate.expectationMet must be a boolean.",
    );
  });

  it("renders a manifest-driven PR comment with inline screenshots and video links", () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const body = render(manifest, links);
    contains(
      body,
      marker,
      "Summary: Mantis reran the scenario.",
      '<table width="100%">',
      '<th width="50%">Baseline queued-only</th>',
      '<th width="50%">Candidate queued -> thinking -> done</th>',
      `<td width="50%" align="center"><img src="${rawBase}/baseline.png" width="100%"`,
      `[Baseline change MP4](${rawBase}/baseline-change.mp4)`,
      "- Overall: `pass`",
    );
    expect(body).not.toContain("raw.githubusercontent.com");
  });

  it("renders trusted lane digests and their count differential", () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    manifest.comparison = {
      baseline: {
        ...lane("baseline behavior", "aaa", "pass"),
        digest:
          "2 sent · 2 bot messages · 1 edit · 1 delete · 3 provider requests · 134s observed · attempt 1 · sent: `/queue followup`",
      },
      candidate: {
        ...lane("candidate behavior", "bbb", "pass"),
        digest:
          "2 sent · 3 bot messages · 1 edit · 0 deletes · 3 provider requests · 134s observed · attempt 1 · sent: `/queue followup`",
      },
      differential: "bot messages 2→3 · deletes 1→0",
      outcome: "pass",
      pass: true,
    };

    contains(
      render(manifest),
      "- Baseline: `pass` at `aaa` — baseline behavior · facts: 2 sent · 2 bot messages · 1 edit · 1 delete · 3 provider requests · 134s observed · attempt 1 · sent: `/queue followup`",
      "- Candidate (PR merged onto main): `pass` at `bbb` — candidate behavior · facts: 2 sent · 3 bot messages · 1 edit · 0 deletes · 3 provider requests · 134s observed · attempt 1 · sent: `/queue followup`",
      "- Differential (trusted facts): bot messages 2→3 · deletes 1→0\n- Overall: `pass`",
    );
  });

  it("uploads manifest artifacts to R2-compatible object storage", async () => {
    const requests: Array<Parameters<ArtifactFetch>[1] & { url: string }> = [];
    const fetchImpl: ArtifactFetch = async (url, init) => {
      requests.push({ ...init, url: url.toString() });
      return new Response("", { status: 200 });
    };

    const published = await upload(fetchImpl);

    expect(published).toEqual({
      artifactRoot,
      rawBase,
      treeUrl: `${rawBase}/index.json`,
    });
    expect(requests.map((request) => request.method)).toEqual(["PUT", "PUT", "PUT", "PUT", "PUT"]);
    expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true);
    expect(requests.map((request) => request.url)).toEqual(
      [
        "baseline.png",
        "candidate.png",
        "baseline-change.mp4",
        "mantis-evidence.json",
        "index.json",
      ].map((file) => `${storageConfig.endpoint}/${storageConfig.bucket}/${artifactRoot}/${file}`),
    );
    expect(requests[0]?.headers).toMatchObject({
      "content-type": "image/png",
      "x-amz-date": expect.any(String),
    });
    expect((requests[0]?.headers as Record<string, string> | undefined)?.authorization).toContain(
      "Credential=access/",
    );
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

    const result = upload(
      async () => new Response(body, { status: 503, statusText: "Service Unavailable" }),
    );

    await expect(result).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Failed to upload Mantis artifact baseline\.png: 503 Service Unavailable\nMantis upload error response body exceeded 65536 bytes$/u,
      ),
    });
    // Unbounded response.text() would keep pulling forever; the bound cancels after ~64 KiB.
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

    const result = upload(
      async () => new Response(body, { status: 503, statusText: "Service Unavailable" }),
      50,
    );

    await expect(result).rejects.toMatchObject({
      cause: { name: "TimeoutError" },
      message: "Timed out uploading Mantis artifact baseline.png after 50ms.",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(cancelled).toBe(true);
  });

  it("reads small non-ok upload error response bodies within the bound", async () => {
    const smallBody = "access denied: invalid credentials";

    const result = upload(
      async () => new Response(smallBody, { status: 403, statusText: "Forbidden" }),
    );

    await expect(result).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Failed to upload Mantis artifact baseline\.png: 403 Forbidden\naccess denied: invalid credentials$/u,
      ),
    });
  });

  it("allows failure manifests to omit optional visual artifacts", () => {
    const dir = tempDirs.make("mantis-evidence-test-");
    writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ status: "fail" }));
    writeFileSync(path.join(dir, "report.md"), "bootstrap failed before screenshot");
    const manifestPath = writeManifest(dir, {
      id: "slack-desktop-smoke",
      title: "Mantis Slack Desktop Smoke QA",
      summary: "Mantis could not finish VM setup.",
      scenario: "slack-openclaw-desktop-smoke",
      comparison: {
        candidate: lane("Slack QA and VM gateway setup pass", "bbb", "fail", false),
        pass: false,
      },
      artifacts: [
        {
          alt: "Slack Web desktop screenshot from the Mantis VM",
          inline: true,
          kind: "desktopScreenshot",
          label: "Slack desktop/VNC browser",
          lane: "candidate",
          path: "slack-desktop-smoke.png",
          required: false,
          targetPath: "slack-desktop.png",
        },
        runArtifact("metadata", "summary.json", "Slack desktop summary"),
        runArtifact("report", "report.md", "Slack desktop report"),
      ],
    });

    const manifest = loadEvidenceManifest(manifestPath);
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
      "summary.json",
      "report.md",
      "mantis-evidence.json",
    ]);
    const slackBase = "https://qa.openclaw.ai/mantis/slack/pr-1/run-1";
    const body = render(manifest, {
      ...links,
      marker: "<!-- mantis-slack-desktop-smoke -->",
      rawBase: slackBase,
      treeUrl: slackBase,
    });
    contains(body, "Summary: Mantis could not finish VM setup.", "- Overall: `fail`");
    expect(body).not.toContain("<img ");
  });

  it("rejects artifact paths that escape the manifest directory", () => {
    const manifestPath = writeManifest(tempDirs.make("mantis-evidence-test-"), {
      artifacts: [{ kind: "metadata", path: "../outside.json" }],
    });

    expect(() => loadEvidenceManifest(manifestPath)).toThrow(/escapes manifest directory/u);
  });
});
