import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareReleaseJobsByName,
  releaseChildSpec,
} from "../../scripts/full-release-validation-policy.mjs";
import { canonicalizeJsonValue } from "../../scripts/lib/canonical-json.mjs";
import { releaseChildDispatchInputs } from "../../scripts/lib/full-release-child-request.mjs";
import {
  discoverReusableReleaseChild,
  validateReusableReleaseChild,
} from "../../scripts/lib/full-release-child-reuse.mjs";
import { createReleaseEvidenceReplay } from "../../scripts/lib/release-evidence-replay.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

// Keep promise-based retry sleeps on the same clock as the deadline assertions.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: (delay: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, delay);
    }),
}));

const REPOSITORY = "openclaw/openclaw";
const TOOLING = "a".repeat(40);
const TARGET = "b".repeat(40);
const PUBLISHER = "Seal full release child evidence / Seal child receipt";
const NOW = Date.parse("2026-09-23T12:00:00Z");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonDigest(value: unknown) {
  return digest(JSON.stringify(canonicalizeJsonValue(value)));
}

async function fixture(
  role = "normalCi",
  dispatchInputs?: Record<string, string>,
  workflowSha = TOOLING,
  workloadJobCount = 2,
  runAttemptCount = 1,
) {
  const { workflow, suffix, displayName } = releaseChildSpec(role);
  const workflowRef = workflowSha === TARGET ? `release-ci/${TARGET.slice(0, 12)}-123` : "main";
  const dispatchId = `full-release-validation-77-1${suffix}`;
  const inputs: Record<string, string> =
    dispatchInputs ??
    (role === "pluginPrereleaseCandidate"
      ? { target_ref: TARGET, phase: "candidate", candidate_artifact_json: '{"id":"801"}' }
      : { target_ref: TARGET, release_scope: "full" });
  const request = {
    repository: REPOSITORY,
    targetSha: TARGET,
    workflowSha,
    role,
    inputs,
  };
  const run = {
    id: 101,
    run_attempt: runAttemptCount,
    event: "workflow_dispatch",
    path: `.github/workflows/${workflow}@refs/heads/${workflowRef}`,
    display_title: `${displayName} ${dispatchId}`,
    head_branch: workflowRef,
    head_sha: workflowSha,
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
    run_attempt: 1,
    path: ".github/workflows/full-release-validation.yml",
    status: "completed",
    conclusion: "failure" as string | null,
  };
  const rawJob = (id: number, name: string) => ({
    id,
    name,
    run_id: 101,
    run_attempt: 1,
    head_sha: workflowSha,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-23T00:00:00Z",
    completed_at: "2026-09-23T00:01:00Z",
    html_url: `https://github.com/${REPOSITORY}/actions/runs/101/job/${id}`,
    steps: [] as { name: string; status: string; conclusion: string }[],
  });
  const jobs = [
    ...Array.from({ length: workloadJobCount }, (_, index) =>
      rawJob(index + 1, ["node tests", "resolve target"][index] ?? `workload ${index + 1}`),
    ),
    rawJob(workloadJobCount + 1, PUBLISHER),
  ];
  jobs.at(-1)!.steps = [
    "Checkout trusted child evidence tooling",
    "Seal exact child attempt evidence",
    "Upload sealed child evidence",
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  const composite = {
    effectiveRunAttempt: runAttemptCount,
    plannedRunAttempt: 1,
    jobs: jobs
      .slice(0, -1)
      .toSorted(compareReleaseJobsByName)
      .map((job) => ({
        acceptedRunAttempt: runAttemptCount,
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
    workflowSha,
    workflowRef,
    workflowPath: `.github/workflows/${workflow}`,
    displayTitle: run.display_title,
    dispatchId,
    sourceParentRunId: "77",
    sourceParentAttempt: 1,
    workloadConclusion: "success",
    inputs: { ...request.inputs },
    publisher: { jobId: String(workloadJobCount + 1), jobName: PUBLISHER },
    ...composite,
    compositeJobsSha256: jsonDigest(composite),
    dispatchActor: "github-actions[bot]",
    triggeringActor: "github-actions[bot]",
    observedRunAttempts: Array.from({ length: runAttemptCount }, (_, index) => index + 1),
    runId: "101",
    sha256: "",
  };
  const artifact = {
    id: 301,
    name: `full-release-child-evidence-${TARGET}-${role}-101-${runAttemptCount}`,
    digest: "",
    expired: false,
    expires_at: "2026-10-01T00:00:00Z",
    size_in_bytes: 0,
    workflow_run: { id: 101, head_sha: workflowSha, repository_id: 1, head_repository_id: 1 },
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
  const attempts = Array.from({ length: runAttemptCount }, (_, index) =>
    index === 0 ? jobs : jobs.map((job) => ({ ...job, run_attempt: index + 1 })),
  );
  const reads: string[] = [];
  const responses: Record<string, () => unknown> = {
    "actions/runs/101": () => run,
    [`compare/${TOOLING}...main?per_page=1`]: () => lineage,
    "actions/artifacts/301": () => artifact,
    "actions/runs/77/attempts/1": () => parent,
  };
  const deps = {
    now: NOW,
    report: vi.fn<(message: string) => void>(),
    async github(this: void, endpoint: string): Promise<unknown> {
      reads.push(endpoint);
      if (
        /^actions\/workflows\/[^/]+\/runs\?event=workflow_dispatch&per_page=(30|100)$/u.test(
          endpoint,
        )
      ) {
        return { workflow_runs: runInventory };
      }
      const response = responses[endpoint];
      if (response) {
        return response();
      }
      if (endpoint.startsWith("actions/runs/101/artifacts?")) {
        return { total_count: 1, artifacts: [artifact] };
      }
      if (/^actions\/runs\/[0-9]+\/artifacts\?/u.test(endpoint)) {
        return { total_count: 0, artifacts: [] };
      }
      const attempt =
        /^actions\/runs\/101\/attempts\/([1-9][0-9]*)\/jobs\?per_page=(100|50|30)&page=([1-9][0-9]*)$/u.exec(
          endpoint,
        );
      if (attempt) {
        const attemptJobs = attempts[Number(attempt[1]) - 1]!;
        const perPage = Number(attempt[2]);
        const start = (Number(attempt[3]) - 1) * perPage;
        return { total_count: attemptJobs.length, jobs: attemptJobs.slice(start, start + perPage) };
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
  it("reads twelve complete inventories four at a time within the shared deadline", async () => {
    const data = await fixture("normalCi", undefined, TOOLING, 261, 12);
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    vi.useFakeTimers();
    const started = Date.now();
    // Thirteen reads per attempt exceed 120s serially; skew also exercises out-of-order completion.
    let active = 0;
    let peak = 0;
    const reads = new Map<number, string[]>();
    const completed: number[] = [];
    const github = async (endpoint: string) => {
      const match = /attempts\/(\d+)\/jobs\?(.*)$/u.exec(endpoint);
      if (!match) {
        return data.deps.github(endpoint);
      }
      const attempt = Number(match[1]);
      const pages = reads.get(attempt) ?? [];
      reads.set(attempt, pages);
      pages.push(match[2]!);
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000 + (4 - (attempt % 4)) * 100);
        });
        if (/per_page=(100|50)&page=2$/u.test(endpoint)) {
          throw new Error("gh: Server Error (HTTP 502)");
        }
        if (endpoint.endsWith("per_page=30&page=9")) {
          completed.push(attempt);
        }
        return await data.deps.github(endpoint);
      } finally {
        active -= 1;
      }
    };
    const verification = validateReusableReleaseChild(selection, data.request, {
      ...data.deps,
      github,
      deadlineMs: started + 120_000,
    });
    const checked = expect(verification).resolves.toMatchObject({ receipt: data.receipt });
    await vi.runAllTimersAsync();
    await checked;
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(completed).toHaveLength(12);
    expect(completed.slice(0, 4)).toEqual([3, 2, 1, 4]);
    expect([...reads.keys()]).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    for (const pages of reads.values()) {
      expect(pages).toEqual([
        "per_page=100&page=1",
        "per_page=100&page=2",
        "per_page=50&page=1",
        "per_page=50&page=2",
        ...Array.from({ length: 9 }, (_, index) => `per_page=30&page=${index + 1}`),
      ]);
    }
  });

  it("settles started inventories after failure without claiming more attempts", async () => {
    const data = await fixture("normalCi", undefined, TOOLING, 2, 12);
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    data.reads.length = 0;
    vi.useFakeTimers();
    let active = 0;
    let settled = false;
    const started: number[] = [];
    const github = async (endpoint: string) => {
      const match = /attempts\/(\d+)\/jobs\?/u.exec(endpoint);
      if (!match) {
        return data.deps.github(endpoint);
      }
      const attempt = Number(match[1]);
      started.push(attempt);
      active += 1;
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, attempt === 1 ? 1_000 : 2_000);
        });
        if (attempt === 1) {
          throw new Error("gh: Forbidden (HTTP 403)");
        }
        return await data.deps.github(endpoint);
      } finally {
        active -= 1;
      }
    };
    const verification = validateReusableReleaseChild(selection, data.request, {
      ...data.deps,
      github,
    }).finally(() => {
      settled = true;
    });
    const checked = expect(verification).rejects.toThrow("HTTP 403");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(active).toBe(3);
    await vi.runAllTimersAsync();
    await checked;
    expect(active).toBe(0);
    expect(started).toEqual([1, 2, 3, 4]);
    expect(data.reads).not.toContain("actions/runs/77/attempts/1");
    expect(data.reads.filter((endpoint) => endpoint === "actions/runs/101")).toHaveLength(1);
  });

  it.each([
    { status: 502, failures: 1 },
    { status: 502, failures: 4 },
    { status: 403, failures: 1 },
  ])(
    "bounds metadata HTTP $status retries after $failures failures",
    async ({ status, failures }) => {
      const data = await fixture();
      const selection = await discoverReusableReleaseChild(data.request, data.deps);
      vi.useFakeTimers();
      const started = Date.now();
      let reads = 0;
      const github = async (endpoint: string) => {
        if (endpoint === "actions/runs/101" && reads++ < failures) {
          throw Object.assign(new Error("private CLI output"), {
            stderr: `gh: Server Error (HTTP ${status}) private response body`,
          });
        }
        return data.deps.github(endpoint);
      };
      const verification = validateReusableReleaseChild(selection, data.request, {
        ...data.deps,
        github,
      });
      const succeeds = status === 502 && failures === 1;
      const checked = succeeds
        ? expect(verification).resolves.toMatchObject({ receipt: { jobs: data.receipt.jobs } })
        : expect(verification).rejects.toMatchObject({
            message: `Full release child evidence API GET repos/openclaw/openclaw/actions/runs/101 failed (HTTP ${status})`,
          });
      await vi.runAllTimersAsync();
      await checked;
      expect(reads).toBe(succeeds ? 3 : failures);
      expect(Date.now() - started).toBe(status === 403 ? 0 : failures === 4 ? 14_000 : 2_000);
    },
  );

  it("keeps job fallback and retry backoff within the shared deadline", async () => {
    const data = await fixture("normalCi", undefined, TOOLING, 261);
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    vi.useFakeTimers();
    const started = Date.now();
    const jobReads: string[] = [];
    const github = async (endpoint: string) => {
      if (endpoint.includes("/jobs?")) {
        jobReads.push(endpoint);
        if (!endpoint.includes("per_page=100&page=1")) {
          vi.setSystemTime(started + 119_000);
          throw new Error("gh: Server Error (HTTP 502)");
        }
      }
      return data.deps.github(endpoint);
    };
    await expect(
      validateReusableReleaseChild(selection, data.request, {
        ...data.deps,
        github,
        deadlineMs: started + 120_000,
      }),
    ).rejects.toThrow(/API GET .*per_page=30&page=1 exceeded its time budget/);
    expect(jobReads).toEqual([
      "actions/runs/101/attempts/1/jobs?per_page=100&page=1",
      "actions/runs/101/attempts/1/jobs?per_page=100&page=2",
      "actions/runs/101/attempts/1/jobs?per_page=50&page=1",
      "actions/runs/101/attempts/1/jobs?per_page=30&page=1",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([502, 403, "header"])(
    "handles HTTP %s at the child job listing boundary",
    async (status) => {
      const data = await fixture("normalCi", undefined, TOOLING, 261);
      const selection = await discoverReusableReleaseChild(data.request, data.deps);
      const jobReads: string[] = [];
      const github = async (endpoint: string) => {
        if (!endpoint.includes("/jobs?")) {
          return data.deps.github(endpoint);
        }
        jobReads.push(endpoint);
        if (status === 403 || endpoint.includes("per_page=100&page=2")) {
          throw status === "header"
            ? Object.assign(new Error("gh failed"), { stdout: "HTTP/2 502\nprivate response body" })
            : new Error(`gh: Server Error (HTTP ${status})`);
        }
        return data.deps.github(endpoint);
      };
      const verified = validateReusableReleaseChild(selection, data.request, {
        ...data.deps,
        github,
      });
      if (status !== 403) {
        await expect(verified).resolves.toMatchObject({ receipt: { jobs: data.receipt.jobs } });
        expect(jobReads).toEqual([
          "actions/runs/101/attempts/1/jobs?per_page=100&page=1",
          "actions/runs/101/attempts/1/jobs?per_page=100&page=2",
          ...Array.from(
            { length: 6 },
            (_, index) => `actions/runs/101/attempts/1/jobs?per_page=50&page=${index + 1}`,
          ),
        ]);
      } else {
        await expect(verified).rejects.toThrow("HTTP 403");
        expect(jobReads).toHaveLength(1);
      }
    },
  );

  it("replays exact raw child evidence but refuses fresh child and source-parent attempts", async () => {
    const data = await fixture();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    const { downloadArchive, ...deps } = data.deps;
    const { archiveBytes } = await downloadArchive();
    let zipReads = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith("/zip")) {
        zipReads += 1;
        return new Response(Uint8Array.from(archiveBytes));
      }
      return Response.json(data.artifact);
    });
    const github = async (endpoint: string) =>
      endpoint === "actions/runs/77" ? data.parent : deps.github(endpoint);
    const writer = createReleaseEvidenceReplay(data.request);
    await validateReusableReleaseChild(selection, data.request, {
      ...deps,
      github,
      token: "synthetic",
      immutableReads: writer,
    });
    expect(zipReads).toBe(1);
    const payload = JSON.parse(writer.serialize());
    const replay = createReleaseEvidenceReplay(data.request, payload);
    await validateReusableReleaseChild(selection, data.request, {
      ...deps,
      github,
      token: "synthetic",
      immutableReads: replay,
    });
    expect(zipReads).toBe(1);
    data.parent.run_attempt = 2;
    await expect(
      validateReusableReleaseChild(selection, data.request, {
        ...deps,
        github,
        token: "synthetic",
        immutableReads: createReleaseEvidenceReplay(data.request, payload),
      }),
    ).rejects.toThrow(/source parent attempt/);
    data.parent.run_attempt = 1;
    data.run.run_attempt = 2;
    await expect(
      validateReusableReleaseChild(selection, data.request, {
        ...deps,
        github,
        token: "synthetic",
        immutableReads: createReleaseEvidenceReplay(data.request, payload),
      }),
    ).rejects.toThrow();
  });

  it("accepts candidate-owned evidence outside main ancestry", async () => {
    const data = await fixture("normalCi", undefined, TARGET);
    const workflowRef = `release-ci/${TARGET.slice(0, 12)}-123`;
    data.lineage.status = "diverged";

    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection).not.toBeNull();
    await expect(
      validateReusableReleaseChild(selection!, data.request, data.deps),
    ).resolves.toMatchObject({ receipt: { workflowSha: TARGET, workflowRef } });
    expect(data.reads).not.toContain(`compare/${TARGET}...main?per_page=1`);
  });

  it("matches GitHub's omitted empty defaults for productPerformance", async () => {
    const inputs = releaseChildDispatchInputs(
      readFileSync(".github/workflows/openclaw-performance.yml", "utf8"),
      ["target_ref=" + TARGET, "profile=release", "repeat=3", "publish_reports=false"].flatMap(
        (field) => ["-f", field],
      ),
    );
    const data = await fixture(
      "productPerformance",
      Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== "")),
    );
    data.request.inputs = inputs;
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection).not.toBeNull();
    expect(selection!.inputs).toEqual(data.receipt.inputs);
    expect(selection!.inputs.mode).toBe("kova");
    await expect(
      validateReusableReleaseChild({ ...selection, inputs }, data.request, data.deps),
    ).resolves.toMatchObject({ receipt: { inputs: data.receipt.inputs } });
    Object.assign(data.receipt.inputs, inputs);
    await data.seal();
    data.request.inputs = selection!.inputs;
    expect(await discoverReusableReleaseChild(data.request, data.deps)).not.toBeNull();
  });

  it.each([
    { workflowSha: "", reason: "current parent workflow SHA is invalid" },
    { workflowSha: "c".repeat(40), reason: "same tooling is required" },
  ])("rejects invalid current-parent tooling: $reason", async ({ workflowSha, reason }) => {
    const data = await fixture();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    data.request.workflowSha = workflowSha;
    await expect(validateReusableReleaseChild(selection, data.request, data.deps)).rejects.toThrow(
      reason,
    );
    if (!workflowSha) {
      await expect(discoverReusableReleaseChild(data.request, data.deps)).rejects.toThrow(reason);
      return;
    }
    expect(await discoverReusableReleaseChild(data.request, data.deps)).toBeNull();
    expect(data.deps.report).toHaveBeenCalledWith(
      expect.stringContaining(
        `run 101 ${data.run.display_title}: rejected: tooling ${TOOLING} differs from current parent ${"c".repeat(40)}`,
      ),
    );
    expect(data.deps.report).toHaveBeenCalledWith(
      expect.stringContaining('evaluated 0; dispatching fresh work; skipped {"other tooling":1}'),
    );
  });

  it.each(["active parent", "publisher cleanup failure"])(
    "reuses sealed green work despite %s",
    async (state) => {
      const data = await fixture();
      if (state === "active parent") {
        Object.assign(data.parent, { status: "in_progress", conclusion: null });
      } else {
        data.jobs[2]!.conclusion = "failure";
        data.jobs[2]!.steps.push({
          name: "Post cleanup",
          status: "completed",
          conclusion: "failure",
        });
      }
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
    const data = await fixture("pluginPrereleaseIndependent", {
      phase: "independent",
      target_ref: TARGET,
    });
    data.request.inputs.candidate_artifact_json = "";
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
    data.artifact.name = `full-release-child-evidence-${TARGET}-pluginPrereleaseIndependent-101-2`;
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
    expect(selection).not.toBeNull();
    expect(selection?.runAttempt).toBe(2);
    expect(selection?.inputs).not.toHaveProperty("candidate_artifact_json");
    expect(
      (await validateReusableReleaseChild(selection, data.request, data.deps)).receipt.jobs,
    ).toEqual(data.receipt.jobs);
  });

  it.each<
    [
      string,
      (
        data: Awaited<ReturnType<typeof fixture>>,
        selection: NonNullable<Awaited<ReturnType<typeof discoverReusableReleaseChild>>>,
      ) => void | Promise<void>,
      string,
    ]
  >([
    [
      "non-main-ancestor tooling",
      (data) => void (data.lineage.status = "diverged"),
      "not a main ancestor",
    ],
    ["new child attempt", (data) => void (data.run.run_attempt = 2), "current successful attempt"],
    [
      "failed child",
      (data) => void (data.run.conclusion = "failure"),
      "current successful attempt",
    ],
    [
      "different workflow",
      (data) => void (data.run.path = ".github/workflows/counterfeit.yml"),
      "provenance changed",
    ],
    [
      "foreign repository",
      (data) => void (data.run.head_repository.full_name = "other/repo"),
      "current successful attempt",
    ],
    [
      "expired artifact",
      (data) => void (data.artifact.expires_at = "2026-09-22T00:00:00Z"),
      "artifact identity, digest, or expiry",
    ],
    [
      "counterfeit artifact owner",
      (data) => void (data.artifact.workflow_run.id = 999),
      "artifact identity, digest, or expiry",
    ],
    [
      "failed upload hidden by job COE",
      (data) => void (data.jobs[2]!.steps[2]!.conclusion = "failure"),
      "publisher step did not succeed",
    ],
    [
      "failed seal",
      (data) => void (data.jobs[2]!.steps[1]!.conclusion = "failure"),
      "publisher step did not succeed",
    ],
    [
      "changed workload",
      (data) => void (data.jobs[0]!.conclusion = "failure"),
      "complete live composite",
    ],
    ["omitted job", (data) => void data.jobs.splice(0, 1), "complete live composite"],
    [
      "counterfeit parent origin",
      (data) => void (data.parent.path = ".github/workflows/unrelated.yml"),
      "source parent origin",
    ],
    [
      "different parent workflow SHA",
      (data) => void (data.parent.head_sha = "c".repeat(40)),
      "source parent origin",
    ],
    [
      "different parent workflow ref",
      (data) => void (data.parent.head_branch = "other-transport"),
      "source parent origin",
    ],
    [
      "canonical receipt mutation with updated artifact digest",
      async (data, selection) => {
        data.receipt.sourceParentRunId = "78";
        await data.seal();
        Object.assign(selection.artifact, {
          digest: data.artifact.digest,
          sizeInBytes: data.artifact.size_in_bytes,
        });
      },
      "receipt digest changed",
    ],
    [
      "downloaded bytes differing from the selected digest",
      (data) => {
        data.deps.downloadArchive = async () => ({
          artifactMetadata: data.artifact,
          archiveBytes: Buffer.alloc(data.artifact.size_in_bytes),
        });
      },
      "archive bytes differ",
    ],
    [
      "rerun started during artifact verification",
      (data) => {
        const github = data.deps.github;
        data.deps.github = async (endpoint) => {
          if (endpoint === "actions/runs/77/attempts/1") {
            data.run.run_attempt = 2;
          }
          return github(endpoint);
        };
      },
      "current successful attempt",
    ],
  ])("rejects %s at revalidation and discovery", async (_name, mutate, error) => {
    const data = await fixture();
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection).not.toBeNull();
    await mutate(data, selection!);
    await expect(validateReusableReleaseChild(selection, data.request, data.deps)).rejects.toThrow(
      error,
    );
    expect(await discoverReusableReleaseChild(data.request, data.deps)).toBeNull();
  });

  it.each<{ role: string; inputs: Record<string, string> }>([
    { role: "normalCi", inputs: { target_ref: "c".repeat(40) } },
    { role: "normalCi", inputs: { release_scope: "" } },
    { role: "pluginPrereleaseCandidate", inputs: { candidate_artifact_json: '{ "id": "801" }' } },
    { role: "pluginPrereleaseCandidate", inputs: { candidate_artifact_json: "" } },
  ])("requires exact dispatch input bytes for $role: $inputs", async ({ role, inputs }) => {
    const data = await fixture(role);
    expect(await discoverReusableReleaseChild(data.request, data.deps)).not.toBeNull();
    expect(
      await discoverReusableReleaseChild(
        { ...data.request, inputs: { ...data.request.inputs, ...inputs } },
        data.deps,
      ),
    ).toBeNull();
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

  it.each([
    { limit: "current parent", probes: 0, summary: '"current parent":1' },
    {
      limit: "candidates",
      probes: 5,
      summary:
        'scanned 41 runs, evaluated 5; dispatching fresh work; skipped {"budget exhausted":36}',
    },
    {
      limit: "absent receipts",
      probes: 40,
      summary: `no reusable normalCi child for ${TARGET}: scanned 100 runs, evaluated 0; dispatching fresh work; skipped {"not-green":1,"other role/suffix":2,"target receipt absent":40,"budget exhausted":57}`,
    },
    { limit: "deadline", probes: 0, summary: '"budget exhausted":1' },
  ])("bounds discovery by $limit", async ({ limit, probes, summary }) => {
    const data = await fixture();
    const deadlineMs = Date.now() + 120_000;
    const clock = limit === "deadline" ? vi.spyOn(Date, "now") : undefined;
    try {
      if (limit === "candidates") {
        data.runInventory.push(...Array.from({ length: 40 }, () => ({ ...data.run })));
        data.lineage.status = "diverged";
      } else if (limit === "absent receipts") {
        data.runInventory.unshift(
          { ...data.run, conclusion: "failure" },
          { ...data.run, display_title: "Other role" },
          { ...data.run, display_title: "CI full-release-validation-77-1-other-suffix" },
          ...Array.from({ length: 100 }, (_, index) => ({ ...data.run, id: 200 + index })),
        );
      } else if (limit === "deadline") {
        const github = data.deps.github;
        data.deps.github = async (endpoint) => {
          const result = await github(endpoint);
          clock!.mockReturnValue(deadlineMs);
          return result;
        };
      }
      expect(
        await discoverReusableReleaseChild(
          { ...data.request, excludeRunId: limit === "current parent" ? "77" : undefined },
          { ...data.deps, deadlineMs },
        ),
      ).toBeNull();
      expect(data.reads.filter((endpoint) => endpoint.includes("/artifacts?"))).toHaveLength(
        probes,
      );
      if (probes === 0) {
        expect(data.reads).toHaveLength(1);
      }
      expect(data.deps.report).toHaveBeenCalledWith(
        limit === "absent receipts" ? summary : expect.stringContaining(summary),
      );
    } finally {
      clock?.mockRestore();
    }
  });
});
