import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateArtifactJsonFromBinding,
  loadSelectedFullReleaseCandidate,
  resolveCandidateBinding,
  selectTrustedFullReleaseCandidate,
  verifySealedFullReleaseCandidate,
} from "../../scripts/lib/full-release-candidate-reuse.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  canonicalTestJson,
  fullReleaseCandidateBindingFixture,
  fullReleaseCandidateManifestFixture,
  fullReleaseCandidateRequestInput,
} from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const EXPIRES_AT = "2026-09-04T12:00:00Z";
const REPOSITORY = "openclaw/openclaw";
const CONTRACT_SCRIPT = resolve("scripts/full-release-candidate-contract.mjs");
const SCRIPT = resolve("scripts/full-release-candidate-reuse.mjs");
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function archiveWithManifest(value: unknown): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "full-release-candidate.json",
    typeof value === "string" ? value : canonicalTestJson(value),
    { date: new Date("2026-08-28T00:00:00Z") },
  );
  return zip.generateAsync({
    compression: "STORE",
    platform: "UNIX",
    type: "nodebuffer",
  });
}

function workflowRun(runId = 77, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: "failure",
    event: "workflow_dispatch",
    head_branch: "release-ci/tooling",
    head_repository: { full_name: REPOSITORY, id: 1 },
    head_sha: "b".repeat(40),
    id: runId,
    path: `${WORKFLOW_PATH}@refs/heads/release-ci/tooling`,
    repository: { full_name: REPOSITORY, id: 1 },
    run_attempt: 1,
    status: "completed",
    ...overrides,
  };
}

function workflowJobs(
  manifest = fullReleaseCandidateManifestFixture(),
  overrides: { runAttempt?: number; runId?: number } = {},
) {
  const runAttempt = overrides.runAttempt ?? Number(manifest.producer.runAttempt);
  const runId = overrides.runId ?? Number(manifest.producer.runId);
  return {
    jobs: [manifest.producer, manifest.publisher].map((job) => ({
      conclusion: "success",
      head_sha: job.workflowSha,
      id: Number(job.jobId),
      name: job.jobName,
      run_attempt: runAttempt,
      run_id: runId,
      status: "completed",
    })),
    total_count: 2,
  };
}

function artifactMetadata(
  archive: Buffer,
  overrides: Record<string, unknown> = {},
  runOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const manifest = fullReleaseCandidateManifestFixture();
  return {
    created_at: "2026-08-28T10:00:00Z",
    digest: `sha256:${sha256(archive)}`,
    expired: false,
    expires_at: EXPIRES_AT,
    id: 301,
    name: `full-release-candidate-v2-${manifest.requestSha256}`,
    size_in_bytes: archive.length,
    workflow_run: {
      head_repository_id: 1,
      head_sha: manifest.request.toolingSha,
      id: 77,
      repository_id: 1,
      ...runOverrides,
    },
    ...overrides,
  };
}

type CandidateManifestFixture = ReturnType<typeof fullReleaseCandidateManifestFixture>;
type CandidateConstituentSource = Pick<
  CandidateManifestFixture,
  "package" | "prepublishPluginRegistry" | "producer" | "sharedImage"
>;

function constituentArtifactReader(manifest: CandidateConstituentSource) {
  const artifacts = [
    manifest.package.artifact,
    manifest.prepublishPluginRegistry.artifact,
    manifest.sharedImage.artifact,
  ];
  return async (artifactId: string) => {
    const artifact = artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) {
      throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
    }
    return {
      digest: `sha256:${artifact.digest}`,
      expired: false,
      expires_at: artifact.expiresAt,
      id: Number(artifact.id),
      name: artifact.name,
      workflow_run: { head_sha: manifest.producer.workflowSha, id: Number(artifact.runId) },
    };
  };
}

async function fixture(now = NOW) {
  const manifest = fullReleaseCandidateManifestFixture();
  // Pure tests use NOW; CLI cases pass real time without freezing discovery deadlines.
  // Set every expiry before sealing the manifest into the archive and its digest.
  const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  manifest.package.artifact.expiresAt = expiresAt;
  manifest.prepublishPluginRegistry.artifact.expiresAt = expiresAt;
  manifest.sharedImage.artifact.expiresAt = expiresAt;
  const archive = await archiveWithManifest(manifest);
  const metadata = artifactMetadata(archive, {
    created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    expires_at: expiresAt,
  });
  const select = (
    overrides: Partial<Parameters<typeof selectTrustedFullReleaseCandidate>[0]> = {},
  ) =>
    selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      request: manifest.request,
      readWorkflowRun: async (runId: number) => workflowRun(runId),
      readWorkflowJobs: async () => workflowJobs(manifest),
      ...overrides,
    });
  return {
    archive,
    manifest,
    metadata,
    select,
  };
}

async function loadingFixture(
  data?: Pick<Awaited<ReturnType<typeof fixture>>, "archive" | "manifest" | "metadata">,
  runOverrides: Record<string, unknown> = {},
) {
  const { archive, manifest, metadata } = data ?? (await fixture());
  const selected = await selectTrustedFullReleaseCandidate({
    artifacts: [metadata],
    now: NOW,
    request: manifest.request,
    readWorkflowRun: async () => workflowRun(77, runOverrides),
    readWorkflowJobs: async () => workflowJobs(manifest),
  });
  const options = {
    downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
    now: NOW,
    readArtifact: constituentArtifactReader(manifest),
    readRunAttempt: async () => workflowRun(77, runOverrides),
    readWorkflowJobs: async () => workflowJobs(manifest),
    request: manifest.request,
    selected: selected!,
    token: "test-token",
  };
  return { archive, manifest, metadata, options };
}

function discoveryCli(prefix: string) {
  const root = tempDirs.make(`full-release-candidate-${prefix}-`);
  const bin = join(root, "bin");
  const inputPath = join(root, "request-input.json");
  const outputPath = join(root, "github-output");
  const countPath = join(root, "gh-count");
  const callLogPath = join(root, "gh-calls");
  const responsesPath = join(root, "gh-responses.json");
  mkdirSync(bin);
  const ghPath = join(bin, "gh");
  writeFileSync(
    ghPath,
    `#!${testNodeExecPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALL_LOG, args.join(" ") + "\\n");
const countPath = process.env.FAKE_GH_COUNT;
fs.writeFileSync(countPath, String(Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : 0) + 1));
const { replies, errors } = JSON.parse(fs.readFileSync(${JSON.stringify(responsesPath)}, "utf8"));
const endpoint = args.find((arg) => arg.startsWith("repos/${REPOSITORY}/"))?.slice(${`repos/${REPOSITORY}/`.length});
if (Object.hasOwn(errors, endpoint)) {
  console.error(errors[endpoint]);
  process.exit(1);
}
if (!Object.hasOwn(replies, endpoint)) throw new Error("unexpected gh invocation: " + args.join(" "));
process.stdout.write(JSON.stringify(replies[endpoint]));
`,
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
  return {
    root,
    inputPath,
    outputPath,
    countPath,
    callLogPath,
    inventory: (requestSha256 = fullReleaseCandidateManifestFixture().requestSha256, page = 1) =>
      `actions/artifacts?name=full-release-candidate-v2-${requestSha256}&per_page=100&page=${page}`,
    respond: (replies: Record<string, unknown>, errors: Record<string, string> = {}) =>
      writeFileSync(responsesPath, JSON.stringify({ replies, errors })),
    run: (env: NodeJS.ProcessEnv = {}, args: string[] = []) =>
      spawnSync(testNodeExecPath, [SCRIPT, "discover", "--request-input", inputPath, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_GH_COUNT: countPath,
          FAKE_GH_CALL_LOG: callLogPath,
          GH_TOKEN: "test-token",
          GITHUB_OUTPUT: outputPath,
          PATH: `${bin}:${process.env.PATH}`,
          ...env,
        },
        timeout: 10_000,
      }),
  };
}

function expectUnavailable(outputPath: string, reason: string, notMiss = false) {
  const output = readFileSync(outputPath, "utf8");
  for (const line of [`reuse_reason=${reason}`, "state=unavailable", "reused=false"]) {
    expect(output).toContain(line);
  }
  if (notMiss) {
    expect(output).not.toContain("state=miss");
  }
}

async function verificationFixture() {
  const data = await loadingFixture();
  const binding = await loadSelectedFullReleaseCandidate(data.options);
  return {
    ...data,
    binding,
    verification: {
      ...data.options,
      binding,
      consumerRunAttempt: 1,
      consumerRunId: 88,
      readArtifact: async (artifactId: string) =>
        artifactId === binding.evidenceArtifact.id
          ? data.metadata
          : constituentArtifactReader(binding)(artifactId),
    },
  };
}

describe("trusted full release candidate selection", () => {
  it("treats malformed metadata and workflow provenance as misses before selection", async () => {
    const { archive, metadata, select } = await fixture();
    let runReads = 0;
    const selected = await select({
      artifacts: [
        { ...metadata, name: "wrong" },
        { ...metadata, digest: "" },
        { ...metadata, expired: true },
        { ...metadata, expires_at: "2026-08-28T11:59:59Z" },
        { ...metadata, expires_at: "2026-08-29T01:00:00Z" },
        artifactMetadata(archive, { id: 302 }, { head_repository_id: 2, id: 78 }),
        artifactMetadata(archive, { id: 303 }, { head_sha: "9".repeat(40), id: 79 }),
      ],
      readWorkflowRun: async () => {
        runReads += 1;
        return workflowRun();
      },
      readWorkflowJobs: async () => {
        throw new Error("workflow jobs must not be read");
      },
    });
    expect(selected).toBeNull();
    expect(runReads).toBe(0);
  });

  it("orders candidates by newest creation time then descending numeric artifact ID", async () => {
    const { archive, select } = await fixture();
    const selected = await select({
      artifacts: [
        artifactMetadata(archive, { id: 9 }),
        artifactMetadata(archive, { id: 10 }),
        artifactMetadata(archive, { created_at: "2026-08-28T09:00:00Z", id: 99 }),
      ],
    });
    expect(selected?.artifact.id).toBe(10);
  });

  it("stops provenance reads when the discovery deadline is exhausted", async () => {
    const { select } = await fixture();
    let reads = 0;
    await expect(
      select({
        deadlineMs: Date.now() - 1,
        readWorkflowRun: async () => {
          reads += 1;
          return workflowRun();
        },
      }),
    ).rejects.toThrow("candidate discovery exceeded its time budget");
    expect(reads).toBe(0);
  });

  it("skips a trust miss but never falls back after selecting malformed evidence", async () => {
    const { manifest, metadata, select } = await fixture();
    const malformedArchive = await archiveWithManifest("{");
    const newest = artifactMetadata(
      malformedArchive,
      {
        created_at: "2026-08-28T11:00:00Z",
        id: 302,
      },
      { id: 78 },
    );
    const selected = await select({
      artifacts: [metadata, newest],
      readWorkflowJobs: async (runId) => workflowJobs(manifest, { runId }),
    });
    const downloads: number[] = [];
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async ({ expected }) => {
          downloads.push((expected as { artifactId: number }).artifactId);
          return { archiveBytes: malformedArchive, artifactMetadata: newest };
        },
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(78),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("manifest input is invalid JSON");
    expect(downloads).toEqual([302]);
  });
});

describe("full release candidate discovery CLI", () => {
  it("preserves canonical request arrays when checking the expected digest", () => {
    const cli = discoveryCli("canonical");
    const rawInputPath = join(cli.root, "raw-request-input.json");
    const requestPath = cli.inputPath;
    writeFileSync(
      rawInputPath,
      JSON.stringify(
        fullReleaseCandidateRequestInput({
          upgradeSurvivorBaselines: "openclaw@latest",
          upgradeSurvivorScenarios: "base",
        }),
      ),
    );
    const contractResult = spawnSync(
      testNodeExecPath,
      [CONTRACT_SCRIPT, "request", "--input", rawInputPath, "--output", requestPath],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(contractResult.status, contractResult.stderr).toBe(0);
    const contract = JSON.parse(contractResult.stdout) as {
      requestJson: string;
      requestSha256: string;
    };
    const requestBeforeDiscovery = readFileSync(requestPath, "utf8");
    const request = JSON.parse(requestBeforeDiscovery) as {
      upgradeSurvivorBaselines: string[];
      upgradeSurvivorScenarios: string[];
    };
    expect(request.upgradeSurvivorBaselines).toEqual(["openclaw@latest"]);
    expect(request.upgradeSurvivorScenarios).toEqual(["base"]);
    cli.respond({ [cli.inventory(contract.requestSha256)]: { artifacts: [] } });
    const result = cli.run({}, ["--expected-request-sha256", contract.requestSha256]);
    expect(result.status, result.stderr).toBe(0);
    const outputs = Object.fromEntries(
      readFileSync(cli.outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(outputs).toMatchObject({
      request_json: contract.requestJson,
      request_sha256: contract.requestSha256,
      reused: "false",
      state: "miss",
    });
    expect(readFileSync(requestPath, "utf8")).toBe(requestBeforeDiscovery);
    expect(readFileSync(cli.callLogPath, "utf8").trim()).toBe(
      `api repos/${REPOSITORY}/actions/artifacts?name=full-release-candidate-v2-${contract.requestSha256}&per_page=100&page=1`,
    );
  });

  it("marks exhausted transient reads unavailable instead of permitting preparation", () => {
    const cli = discoveryCli("discovery");
    cli.respond({}, { [cli.inventory()]: "HTTP 502: transient candidate lookup failure" });
    const result = cli.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(cli.countPath, "utf8").trim()).toBe("2");
    expectUnavailable(cli.outputPath, "candidate discovery unavailable after bounded retries");
  });

  it("marks bounded artifact inventory exhaustion unavailable instead of permitting preparation", () => {
    const cli = discoveryCli("inventory");
    cli.respond(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          cli.inventory(undefined, index + 1),
          { artifacts: Array.from({ length: 100 }, () => ({})) },
        ]),
      ),
    );
    const result = cli.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(cli.countPath, "utf8").trim()).toBe("10");
    expectUnavailable(cli.outputPath, "candidate artifact inventory exceeded the bounded scan");
  });

  it.each([false, true])(
    "marks bounded candidate evaluation unavailable when older candidates remain (100-job pages 502: %s)",
    async (largePage502) => {
      const cli = discoveryCli("evaluation");
      const replies: Record<string, unknown> = {};
      const errors: Record<string, string> = {};
      const now = Date.now();
      const { manifest, metadata } = await fixture(now);
      const artifacts = Array.from({ length: 6 }, (_, index) => {
        const runId = 80 + index;
        const jobs = workflowJobs(manifest, { runId });
        jobs.jobs[1]!.conclusion = runId === 85 ? "success" : "failure";
        replies[`actions/runs/${runId}`] = workflowRun(runId);
        for (const perPage of [100, 50]) {
          const endpoint = `actions/runs/${runId}/jobs?filter=all&per_page=${perPage}`;
          replies[endpoint] = [jobs];
          if (largePage502 && perPage === 100) {
            errors[endpoint] = "gh: Server Error (HTTP 502)";
          }
        }
        return {
          ...metadata,
          created_at: new Date(now - index * 1000).toISOString(),
          id: 400 + index,
          workflow_run: {
            head_repository_id: 1,
            head_sha: manifest.request.toolingSha,
            id: runId,
            repository_id: 1,
          },
        };
      });
      cli.respond({ ...replies, [cli.inventory()]: { artifacts } }, errors);
      const result = cli.run();
      expect(result.status, result.stderr).toBe(0);
      expectUnavailable(cli.outputPath, "candidate evaluation exceeded the bounded scan", true);
      const candidateCalls = readFileSync(cli.callLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.includes("actions/runs/"));
      expect(candidateCalls).toEqual(
        [80, 81, 82, 83, 84].flatMap((runId) =>
          // A 5xx at 100 rereads the complete listing once at 50, without a same-size retry.
          [`api repos/${REPOSITORY}/actions/runs/${runId}`].concat(
            (largePage502 ? [100, 50] : [100]).map(
              (perPage) =>
                `api --paginate --slurp repos/${REPOSITORY}/actions/runs/${runId}/jobs?filter=all&per_page=${perPage}`,
            ),
          ),
        ),
      );
      expect(candidateCalls.join("\n")).not.toContain("actions/runs/85");
    },
  );

  it("marks a selected candidate with a missing constituent unavailable", async () => {
    const cli = discoveryCli("selected-missing");
    const archivePath = join(cli.root, "candidate.zip");
    const artifactMetadataPath = join(cli.root, "artifact-metadata.json");
    const fetchPreloadPath = join(cli.root, "fetch-preload.mjs");
    const { archive, manifest, metadata } = await fixture(Date.now());
    writeFileSync(archivePath, archive);
    cli.respond(
      {
        [cli.inventory()]: { artifacts: [metadata] },
        "actions/runs/77": workflowRun(),
        "actions/runs/77/jobs?filter=all&per_page=100": [workflowJobs(manifest)],
      },
      { "actions/artifacts/101": "HTTP 404: candidate constituent artifact missing" },
    );
    writeFileSync(artifactMetadataPath, JSON.stringify(metadata));
    writeFileSync(
      fetchPreloadPath,
      `import { readFileSync } from "node:fs";
const archive = readFileSync(process.env.FAKE_ARTIFACT_ARCHIVE);
const metadata = JSON.parse(readFileSync(process.env.FAKE_ARTIFACT_METADATA, "utf8"));
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.endsWith("/actions/artifacts/301")) {
    return new Response(JSON.stringify(metadata), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }
  if (value.endsWith("/actions/artifacts/301/zip")) {
    return new Response(archive, { status: 200 });
  }
  throw new Error(\`unexpected fetch: \${value}\`);
};
`,
    );
    const result = cli.run({
      FAKE_ARTIFACT_ARCHIVE: archivePath,
      FAKE_ARTIFACT_METADATA: artifactMetadataPath,
      NODE_OPTIONS: `--import=${pathToFileURL(fetchPreloadPath).href}`,
    });
    expect(result.status, result.stderr).toBe(0);
    expectUnavailable(
      cli.outputPath,
      "full release candidate package artifact is unavailable",
      true,
    );
  });
});

describe("full release candidate loading", () => {
  it.each([WORKFLOW_PATH, ".github/workflows/full-release-artifacts.yml"])(
    "binds exact candidate artifacts from %s",
    async (path) => {
      const { archive, manifest, metadata, options } = await loadingFixture(undefined, {
        run_attempt: 2,
        path,
      });
      const binding = await loadSelectedFullReleaseCandidate({
        ...options,
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({
            artifactId: 301,
            artifactName: metadata.name,
            runId: 77,
            workflowSha: manifest.request.toolingSha,
          });
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
        readRunAttempt: async (runId, runAttempt) => {
          expect([runId, runAttempt]).toEqual(["77", "1"]);
          return workflowRun(77, { run_attempt: 1, path });
        },
      });
      expect(binding).toMatchObject({
        evidenceArtifact: {
          digest: sha256(archive),
          id: "301",
          runAttempt: "1",
          runId: "77",
        },
        producer: manifest.producer,
        publisher: manifest.publisher,
        request: manifest.request,
      });
    },
  );

  it("accepts an active producer run after the exact producer jobs complete", async () => {
    const { manifest, options } = await loadingFixture(undefined, {
      conclusion: null,
      status: "in_progress",
    });
    await expect(loadSelectedFullReleaseCandidate(options)).resolves.toMatchObject({
      producer: manifest.producer,
    });
  });

  it("stops candidate loading when the discovery deadline is exhausted", async () => {
    const { archive, metadata, options } = await loadingFixture();
    let downloads = 0;
    await expect(
      loadSelectedFullReleaseCandidate({
        ...options,
        deadlineMs: Date.now() - 1,
        downloadArchive: async () => {
          downloads += 1;
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
      }),
    ).rejects.toThrow("candidate discovery exceeded its time budget");
    expect(downloads).toBe(0);
  });

  it("rejects unavailable, expired, or changed constituent artifacts before reuse", async () => {
    const { manifest, options } = await loadingFixture();
    const packageId = manifest.package.artifact.id;
    const cases: Array<[string, Record<string, unknown> | null]> = [
      ["package artifact is unavailable", null],
      ["package artifact is expired or near expiry", { expired: true }],
      ["package artifact identity changed", { digest: `sha256:${"9".repeat(64)}` }],
    ];
    for (const [expected, overrides] of cases) {
      await expect(
        loadSelectedFullReleaseCandidate({
          ...options,
          readArtifact: async (artifactId: string) => {
            if (artifactId === packageId && overrides === null) {
              throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
            }
            const value = await constituentArtifactReader(manifest)(artifactId);
            return artifactId === packageId ? { ...value, ...overrides } : value;
          },
        }),
      ).rejects.toThrow(expected);
    }
  });

  it.each(["producer", "publisher"] as const)(
    "rejects a manifest %s workflow that differs from the selected run",
    async (role) => {
      const { manifest } = await fixture();
      const changedManifest = structuredClone(manifest);
      changedManifest[role].workflowPath = ".github/workflows/candidate-evidence-test.yml";
      const archive = await archiveWithManifest(changedManifest);
      const metadata = artifactMetadata(archive);
      const { options } = await loadingFixture({ archive, metadata, manifest: changedManifest });
      await expect(loadSelectedFullReleaseCandidate(options)).rejects.toThrow(
        "producer or publisher workflow attempt is invalid",
      );
    },
  );

  it("hard-fails an unavailable selected artifact", async () => {
    const { options } = await loadingFixture();
    const error = new Error("GitHub Actions artifact metadata returned HTTP 404.");
    await expect(
      loadSelectedFullReleaseCandidate({
        ...options,
        downloadArchive: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow(error.message);
  });

  it.each([
    ["job name", (jobs) => void (jobs.jobs[1]!.name = "different publisher")],
    ["job conclusion", (jobs) => void (jobs.jobs[1]!.conclusion = "failure")],
  ] satisfies Array<[string, (jobs: ReturnType<typeof workflowJobs>) => void]>)(
    "rejects evidence when the publisher %s differs from the sealed identity",
    async (_label, mutate) => {
      const { manifest, options } = await loadingFixture();
      const jobs = workflowJobs(manifest);
      mutate(jobs);
      await expect(
        loadSelectedFullReleaseCandidate({
          ...options,
          readWorkflowJobs: async () => jobs,
        }),
      ).rejects.toThrow("publisher job did not complete successfully");
    },
  );
});

describe("full release candidate binding authority", () => {
  it("preserves published package provenance across fresh and reused evidence", () => {
    const binding = fullReleaseCandidateBindingFixture({ packagePublished: true });
    const fresh = resolveCandidateBinding({
      freshBinding: binding,
      now: NOW,
      request: binding.request,
      required: true,
    });
    const reused = resolveCandidateBinding({
      now: NOW,
      request: binding.request,
      required: true,
      reusedBinding: binding,
    });
    const freshArtifact = candidateArtifactJsonFromBinding(fresh);

    expect(freshArtifact).toBe(candidateArtifactJsonFromBinding(reused));
    expect(JSON.parse(freshArtifact)).toMatchObject({ packagePublished: true });
  });

  it("rejects missing, ambiguous, expired, and wrong-request evidence", () => {
    const binding = fullReleaseCandidateBindingFixture();
    const resolveBinding = (
      overrides: Partial<Parameters<typeof resolveCandidateBinding>[0]> = {},
    ) =>
      resolveCandidateBinding({ now: NOW, request: binding.request, required: true, ...overrides });
    expect(() => resolveBinding()).toThrow("exactly one");
    expect(() => resolveBinding({ freshBinding: binding, reusedBinding: binding })).toThrow(
      "exactly one",
    );
    for (const now of [Date.parse(EXPIRES_AT), Date.parse(EXPIRES_AT) - 90 * 60 * 1000]) {
      expect(() => resolveBinding({ freshBinding: binding, now })).toThrow(
        "expired or near-expiry",
      );
    }
    expect(() =>
      resolveBinding({
        freshBinding: binding,
        request: { ...binding.request, releaseProfile: "beta" },
      }),
    ).toThrow("does not match");
  });
});

describe("sealed full release candidate verification", () => {
  it("rechecks the exact evidence archive and producer tuple", async () => {
    const { archive, manifest, metadata, binding, verification } = await verificationFixture();
    await expect(
      verifySealedFullReleaseCandidate({
        ...verification,
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({
            artifactDigest: `sha256:${binding.evidenceArtifact.digest}`,
            artifactExpiresAt: binding.evidenceArtifact.expiresAt,
            artifactId: Number(binding.evidenceArtifact.id),
            artifactName: binding.evidenceArtifact.name,
            runId: Number(binding.evidenceArtifact.runId),
          });
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
        readRunAttempt: async (runId, runAttempt) => {
          expect([runId, runAttempt]).toEqual(["77", "1"]);
          return workflowRun();
        },
      }),
    ).resolves.toEqual(binding);

    const changedPublisherJobs = workflowJobs(manifest);
    changedPublisherJobs.jobs[1]!.id = 999;
    await expect(
      verifySealedFullReleaseCandidate({
        ...verification,
        readWorkflowJobs: async () => changedPublisherJobs,
      }),
    ).rejects.toThrow("publisher job did not complete successfully");
  });

  it("fails final verification when a sealed constituent artifact disappears", async () => {
    const { binding, verification } = await verificationFixture();
    await expect(
      verifySealedFullReleaseCandidate({
        ...verification,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.package.artifact.id) {
            throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
          }
          return verification.readArtifact(artifactId);
        },
      }),
    ).rejects.toThrow("HTTP 404");
  });
});
