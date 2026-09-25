import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizeJsonValue } from "../../scripts/lib/canonical-json.mjs";
import {
  discoverReusableReleaseChild,
  validateReusableReleaseChild,
} from "../../scripts/lib/full-release-child-reuse.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const REPOSITORY = "openclaw/openclaw";
const TOOLING = "a".repeat(40);
const TARGET = "b".repeat(40);
const PUBLISHER = "Seal full release child evidence / Seal child receipt";
const NOW = Date.parse("2026-09-23T12:00:00Z");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonDigest(value: unknown) {
  return digest(JSON.stringify(canonicalizeJsonValue(value)));
}

async function fixture(candidate = false) {
  const role = candidate ? "pluginPrereleaseCandidate" : "normalCi";
  const workflow = candidate ? "plugin-prerelease.yml" : "ci.yml";
  const dispatchId = `full-release-validation-77-1${candidate ? "-plugin-prerelease-candidate" : "-ci"}`;
  const inputs: Record<string, string> = candidate
    ? { target_ref: TARGET, phase: "candidate", candidate_artifact_json: '{"id":"801"}' }
    : { target_ref: TARGET, release_scope: "full" };
  const request = {
    repository: REPOSITORY,
    targetSha: TARGET,
    role,
    inputs,
  };
  const run = {
    id: 101,
    run_attempt: 1,
    event: "workflow_dispatch",
    path: `.github/workflows/${workflow}@refs/heads/main`,
    display_title: `${candidate ? "Plugin Prerelease" : "CI"} ${dispatchId}`,
    head_branch: "main",
    head_sha: TOOLING,
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY, id: 1 },
    head_repository: { full_name: REPOSITORY, id: 1 },
    actor: { login: "github-actions[bot]" },
    triggering_actor: { login: "github-actions[bot]" },
  };
  const parent = {
    ...run,
    id: 77,
    path: ".github/workflows/full-release-validation.yml",
    status: "completed",
    conclusion: "failure" as string | null,
  };
  const rawJob = (id: number, name: string) => ({
    id,
    name,
    run_id: 101,
    run_attempt: 1,
    head_sha: TOOLING,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-23T00:00:00Z",
    completed_at: "2026-09-23T00:01:00Z",
    html_url: `https://github.com/${REPOSITORY}/actions/runs/101/job/${id}`,
    steps: [] as { name: string; status: string; conclusion: string }[],
  });
  const jobs = [rawJob(1, "node tests"), rawJob(2, "resolve target"), rawJob(3, PUBLISHER)];
  jobs[2]!.steps = [
    "Checkout trusted child evidence tooling",
    "Seal exact child attempt evidence",
    "Upload sealed child evidence",
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  const composite = {
    effectiveRunAttempt: 1,
    plannedRunAttempt: 1,
    jobs: jobs.slice(0, 2).map((job) => ({
      acceptedRunAttempt: 1,
      completedAt: job.completed_at,
      conclusion: job.conclusion,
      name: job.name,
      startedAt: job.started_at,
      status: job.status,
      url: job.html_url,
    })),
  };
  const receipt = {
    schema: "openclaw.full-release-child-evidence/v1",
    repository: REPOSITORY,
    role,
    targetSha: TARGET,
    workflowSha: TOOLING,
    workflowRef: "main",
    workflowPath: `.github/workflows/${workflow}`,
    displayTitle: run.display_title,
    dispatchId,
    sourceParentRunId: "77",
    sourceParentAttempt: 1,
    workloadConclusion: "success",
    inputs: { ...request.inputs },
    publisher: { jobId: "3", jobName: PUBLISHER },
    ...composite,
    compositeJobsSha256: jsonDigest(composite),
    dispatchActor: "github-actions[bot]",
    triggeringActor: "github-actions[bot]",
    observedRunAttempts: [1],
    runId: "101",
    sha256: "",
  };
  const artifact = {
    id: 301,
    name: `full-release-child-evidence-${TARGET}-${role}-101-1`,
    digest: "",
    expired: false,
    expires_at: "2026-10-01T00:00:00Z",
    size_in_bytes: 0,
    workflow_run: { id: 101, head_sha: TOOLING, repository_id: 1, head_repository_id: 1 },
  };
  let archiveBytes: Buffer;
  async function seal() {
    const { sha256: _oldDigest, ...payload } = receipt;
    receipt.sha256 = jsonDigest(payload);
    const zip = new JSZip();
    zip.file("full-release-child-evidence.json", JSON.stringify(receipt), {
      date: new Date("2026-09-23T00:00:00Z"),
    });
    archiveBytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    artifact.digest = `sha256:${digest(archiveBytes)}`;
    artifact.size_in_bytes = archiveBytes.length;
  }
  await seal();
  const lineage = { status: "ahead", merge_base_commit: { sha: TOOLING } };
  const runInventory = [run];
  const attempts = [jobs];
  const reads: string[] = [];
  const deps = {
    now: NOW,
    async github(this: void, endpoint: string): Promise<unknown> {
      reads.push(endpoint);
      if (endpoint === `actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=30`) {
        return { workflow_runs: runInventory };
      }
      if (endpoint === "actions/runs/101") {
        return run;
      }
      if (endpoint === `compare/${TOOLING}...main?per_page=1`) {
        return lineage;
      }
      if (endpoint === "actions/artifacts/301") {
        return artifact;
      }
      if (endpoint.startsWith("actions/runs/101/artifacts?")) {
        return { total_count: 1, artifacts: [artifact] };
      }
      const attempt =
        /^actions\/runs\/101\/attempts\/([1-9][0-9]*)\/jobs\?per_page=100&page=1$/u.exec(endpoint);
      if (attempt) {
        const attemptJobs = attempts[Number(attempt[1]) - 1]!;
        return { total_count: attemptJobs.length, jobs: attemptJobs };
      }
      if (endpoint === "actions/runs/77/attempts/1") {
        return parent;
      }
      throw new Error(`Unexpected evidence read: ${endpoint}`);
    },
    async downloadArchive(this: void) {
      return { artifactMetadata: artifact, archiveBytes };
    },
  };
  return {
    request,
    run,
    parent,
    jobs,
    receipt,
    artifact,
    seal,
    deps,
    reads,
    lineage,
    runInventory,
    attempts,
  };
}

describe("independent release child reuse", () => {
  it.each([
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "cancelled" },
    { status: "in_progress", conclusion: null },
  ])(
    "reuses green children from $status/$conclusion parents without a manifest",
    async (parentState) => {
      const data = await fixture();
      Object.assign(data.parent, parentState);
      const selection = await discoverReusableReleaseChild(data.request, data.deps);
      expect(selection).toMatchObject({
        role: "normalCi",
        runId: "101",
        runAttempt: 1,
        sourceParentRunId: "77",
        sourceParentAttempt: 1,
        receiptSha256: data.receipt.sha256,
      });
      const verified = await validateReusableReleaseChild(selection, data.request, data.deps);
      expect(verified.receipt.jobs).toEqual(data.receipt.jobs);
    },
  );

  it("carries green workload jobs through publisher-only failed-job retries", async () => {
    const data = await fixture();
    data.jobs[2]!.conclusion = "failure";
    data.jobs[2]!.steps[2]!.conclusion = "failure";
    data.run.run_attempt = 2;
    data.run.triggering_actor.login = "release-maintainer";
    data.attempts.push([
      {
        ...data.jobs[2]!,
        id: 4,
        run_attempt: 2,
        conclusion: "success",
        steps: data.jobs[2]!.steps.map((step) =>
          Object.assign({}, step, { conclusion: "success" }),
        ),
      },
    ]);
    data.artifact.name = `full-release-child-evidence-${TARGET}-normalCi-101-2`;
    data.receipt.effectiveRunAttempt = 2;
    data.receipt.observedRunAttempts = [1, 2];
    data.receipt.triggeringActor = "release-maintainer";
    data.receipt.publisher.jobId = "4";
    data.receipt.compositeJobsSha256 = jsonDigest({
      effectiveRunAttempt: 2,
      plannedRunAttempt: 1,
      jobs: data.receipt.jobs,
    });
    await data.seal();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection?.runAttempt).toBe(2);
    expect(
      (await validateReusableReleaseChild(selection, data.request, data.deps)).receipt.jobs,
    ).toEqual(data.receipt.jobs);
  });

  it("accepts successful immutable seal/upload steps despite publisher cleanup failure", async () => {
    const data = await fixture();
    data.jobs[2]!.conclusion = "failure";
    data.jobs[2]!.steps.push({ name: "Post cleanup", status: "completed", conclusion: "failure" });
    expect(await discoverReusableReleaseChild(data.request, data.deps)).not.toBeNull();
  });

  it.each([
    {
      name: "non-main-ancestor tooling",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.lineage.status = "diverged";
      },
      error: "not a main ancestor",
    },
    {
      name: "new child attempt",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.run.run_attempt = 2;
      },
      error: "current successful attempt",
    },
    {
      name: "failed child",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.run.conclusion = "failure";
      },
      error: "current successful attempt",
    },
    {
      name: "different workflow",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.run.path = ".github/workflows/counterfeit.yml";
      },
      error: "provenance changed",
    },
    {
      name: "foreign repository",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.run.head_repository.full_name = "other/repo";
      },
      error: "current successful attempt",
    },
    {
      name: "expired artifact",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.artifact.expires_at = "2026-09-22T00:00:00Z";
      },
      error: "artifact identity, digest, or expiry",
    },
    {
      name: "counterfeit artifact owner",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.artifact.workflow_run.id = 999;
      },
      error: "artifact identity, digest, or expiry",
    },
    {
      name: "failed upload hidden by job COE",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.jobs[2]!.steps[2]!.conclusion = "failure";
      },
      error: "publisher step did not succeed",
    },
    {
      name: "failed seal",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.jobs[2]!.steps[1]!.conclusion = "failure";
      },
      error: "publisher step did not succeed",
    },
    {
      name: "changed workload",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.jobs[0]!.conclusion = "failure";
      },
      error: "complete live composite",
    },
    {
      name: "omitted job",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.jobs.splice(0, 1);
      },
      error: "complete live composite",
    },
    {
      name: "counterfeit parent origin",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.parent.path = ".github/workflows/unrelated.yml";
      },
      error: "source parent origin",
    },
    {
      name: "different parent workflow SHA",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.parent.head_sha = "c".repeat(40);
      },
      error: "source parent origin",
    },
    {
      name: "different parent workflow ref",
      mutate: (data: Awaited<ReturnType<typeof fixture>>) => {
        data.parent.head_branch = "other-transport";
      },
      error: "source parent origin",
    },
  ])("rejects $name at revalidation and discovery", async ({ mutate, error }) => {
    const data = await fixture();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection).not.toBeNull();
    mutate(data);
    await expect(validateReusableReleaseChild(selection, data.request, data.deps)).rejects.toThrow(
      error,
    );
    expect(await discoverReusableReleaseChild(data.request, data.deps)).toBeNull();
  });

  it.each([
    { target_ref: "c".repeat(40), release_scope: "full" },
    { target_ref: TARGET, release_scope: "npm-beta" },
    { target_ref: TARGET, release_scope: "" },
  ])("rejects different exact dispatch inputs %#", async (inputs) => {
    const data = await fixture();
    expect(await discoverReusableReleaseChild({ ...data.request, inputs }, data.deps)).toBeNull();
  });

  it.each(['{ "id": "801" }', '{"id":"802"}', ""])(
    "requires the exact candidate descriptor bytes %s",
    async (candidate_artifact_json) => {
      const data = await fixture(true);
      expect(await discoverReusableReleaseChild(data.request, data.deps)).not.toBeNull();
      expect(
        await discoverReusableReleaseChild(
          { ...data.request, inputs: { ...data.request.inputs, candidate_artifact_json } },
          data.deps,
        ),
      ).toBeNull();
    },
  );

  it("rejects a canonical receipt mutation even when its artifact digest is updated", async () => {
    const data = await fixture();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    data.receipt.sourceParentRunId = "78";
    await data.seal();
    await expect(
      validateReusableReleaseChild(
        {
          ...selection,
          artifact: {
            ...selection!.artifact,
            digest: data.artifact.digest,
            sizeInBytes: data.artifact.size_in_bytes,
          },
        },
        data.request,
        data.deps,
      ),
    ).rejects.toThrow("receipt digest changed");
    expect(await discoverReusableReleaseChild(data.request, data.deps)).toBeNull();
  });

  it("rejects downloaded bytes that do not match the selected artifact digest", async () => {
    const data = await fixture();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    data.deps.downloadArchive = async () => ({
      artifactMetadata: data.artifact,
      archiveBytes: Buffer.alloc(data.artifact.size_in_bytes),
    });
    await expect(validateReusableReleaseChild(selection, data.request, data.deps)).rejects.toThrow(
      "archive bytes differ",
    );
  });

  it("reads binary archives through configured gh auth and rejects failed transfers", async () => {
    const data = await fixture();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    const root = tempDirs.make("frv-child-gh-archive-");
    const archivePath = join(root, "receipt.zip");
    writeFileSync(archivePath, (await data.deps.downloadArchive()).archiveBytes);
    const gh = join(root, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.slice(2).join(" ") !== "api repos/openclaw/openclaw/actions/artifacts/301/zip") process.exit(2);
process.stdout.write(fs.readFileSync(${JSON.stringify(archivePath)}));
`,
    );
    chmodSync(gh, 0o755);
    vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH ?? ""}`);
    const { downloadArchive: _downloadArchive, ...transport } = data.deps;
    const verified = await validateReusableReleaseChild(selection, data.request, {
      ...transport,
      token: "",
    });
    expect(verified.receipt.sha256).toBe(data.receipt.sha256);
    writeFileSync(gh, `#!${process.execPath}\nprocess.exit(1);\n`);
    await expect(
      validateReusableReleaseChild(selection, data.request, { ...transport, token: "" }),
    ).rejects.toThrow("Command failed");
  });

  it("rejects a rerun started while artifact verification was in flight", async () => {
    const data = await fixture();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    const github = data.deps.github;
    data.deps.github = async (endpoint) => {
      if (endpoint === "actions/runs/77/attempts/1") {
        data.run.run_attempt = 2;
      }
      return github(endpoint);
    };
    await expect(validateReusableReleaseChild(selection, data.request, data.deps)).rejects.toThrow(
      "current successful attempt",
    );
  });

  it("bounds discovery and skips explicitly excluded runs", async () => {
    const data = await fixture();
    expect(
      await discoverReusableReleaseChild({ ...data.request, excludeRunId: "77" }, data.deps),
    ).toBeNull();
    expect(data.reads).toHaveLength(1);
    data.reads.length = 0;
    data.runInventory.push(...Array.from({ length: 40 }, () => ({ ...data.run })));
    data.lineage.status = "diverged";
    expect(await discoverReusableReleaseChild(data.request, data.deps)).toBeNull();
    expect(data.reads.filter((endpoint) => endpoint.includes("/artifacts?"))).toHaveLength(5);
  });
});
