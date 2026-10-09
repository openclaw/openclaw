import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  classifyReleaseSnapshot,
  releaseChildSpec,
} from "../../scripts/full-release-validation-policy.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SCRIPT = resolve("scripts/full-release-child-evidence.mjs");
const SHA = "a".repeat(40);
const TARGET = "b".repeat(40);
const PUBLISHER = "Seal full release child evidence / Seal child receipt";

function fixture(role = "normalCi") {
  const spec = releaseChildSpec(role);
  const workflowSha = TARGET;
  const job = (id: number, name: string, conclusion: string | null = "success") => ({
    id,
    name,
    run_id: 101,
    run_attempt: 1,
    head_sha: workflowSha,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    started_at: "2026-09-23T00:00:00Z",
    completed_at: conclusion === null ? null : "2026-09-23T00:01:00Z",
    html_url: `https://example.invalid/jobs/${id}`,
  });
  const jobs = [job(1, "resolve target"), job(2, "node tests"), job(3, PUBLISHER, null)];
  return {
    run: {
      id: 101,
      run_attempt: 1,
      event: "workflow_dispatch",
      path: `.github/workflows/${spec.workflow}@refs/heads/main`,
      display_title: `${spec.displayName} full-release-validation-77-1${spec.suffix}`,
      head_branch: "main",
      head_sha: workflowSha,
      status: "in_progress",
      conclusion: null,
      repository: { full_name: "openclaw/openclaw" },
      head_repository: { full_name: "openclaw/openclaw" },
      actor: { login: "github-actions[bot]" },
      triggering_actor: { login: "github-actions[bot]" },
    },
    jobs,
    attempts: [jobs],
    role,
  };
}

function seal(data = fixture(), runAttempt = 1) {
  const role = data.role;
  const spec = releaseChildSpec(role);
  const root = tempDirs.make("frv-child-receipt-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const fixturePath = join(root, "fixture.json");
  const event = join(root, "event.json");
  const output = join(root, "output");
  const receipt = join(root, "receipt.json");
  writeFileSync(fixturePath, JSON.stringify(data));
  writeFileSync(
    event,
    JSON.stringify({
      inputs: {
        dispatch_id: `full-release-validation-77-1${spec.suffix}`,
        target_ref: TARGET,
        release_scope: "full",
      },
    }),
  );
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(process.env.FRV_FIXTURE, "utf8"));
const endpoint = process.argv.find((arg) => arg.startsWith("repos/"));
if (endpoint === "repos/openclaw/openclaw/actions/runs/101") {
  process.stdout.write(JSON.stringify(fixture.run));
} else if (endpoint.startsWith("repos/openclaw/openclaw/actions/runs/101/attempts/")) {
  const attempt = Number(endpoint.split("/").at(-2));
  const jobs = fixture.attempts[attempt - 1];
  process.stdout.write(JSON.stringify([{total_count: jobs.length, jobs}]));
} else {
  throw new Error("Unexpected evidence read: " + endpoint);
}
`,
  );
  chmodSync(gh, 0o755);
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_GH_BIN: gh,
      GH_TOKEN: "synthetic-test-token",
      FRV_FIXTURE: fixturePath,
      FRV_CHILD_ROLE: role,
      FRV_CHILD_TARGET_SHA: TARGET,
      FRV_CHILD_EVIDENCE_PATH: receipt,
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ID: "101",
      GITHUB_RUN_ATTEMPT: String(runAttempt),
      GITHUB_SHA: data.run.head_sha,
      GITHUB_REF_NAME: "main",
    },
  });
  return { result, receipt, output };
}

describe("full release child evidence producer", () => {
  it.each(["normalCi"])("blocks failed selected metadata and workload jobs for %s", (key) => {
    const workload = {
      name: "install_smoke",
      status: "completed",
      conclusion: "success",
    };
    const metadata = { name: PUBLISHER, status: "completed", conclusion: "failure" };
    const snapshot = () =>
      classifyReleaseSnapshot({
        children: [
          {
            key,
            selected: true,
            required: true,
            result: "success",
            source: "fresh",
            runId: "101",
            runAttempt: 1,
            status: "completed",
            conclusion: "success",
            jobs: [workload, metadata],
          },
        ],
        releaseProfile: "stable",
        workflowRef: "main",
      });
    expect(snapshot()).toMatchObject({
      state: "blocked_complete",
      blockers: [expect.objectContaining({ job: PUBLISHER, kind: "job_failure" })],
    });
    metadata.conclusion = "success";
    expect(snapshot()).toMatchObject({ state: "passed", blockers: [] });
    workload.conclusion = "failure";
    expect(snapshot()).toMatchObject({
      state: "blocked_complete",
      blockers: [expect.objectContaining({ job: "install_smoke", kind: "job_failure" })],
    });
  });

  it.each([
    "ci.yml",
    "plugin-prerelease.yml",
    "openclaw-release-checks.yml",
    "openclaw-performance.yml",
    "npm-telegram-beta-e2e.yml",
  ])("waits for every workload job in %s before sealing", (filename) => {
    const workflow = parse(readFileSync(`.github/workflows/${filename}`, "utf8")) as {
      jobs: Record<string, { needs?: string[]; uses?: string }>;
    };
    const sealJob = workflow.jobs.seal_release_child_evidence;
    expect(sealJob?.uses).toBe("./.github/workflows/full-release-child-evidence.yml");
    expect(sealJob?.needs?.toSorted()).toEqual(
      Object.keys(workflow.jobs)
        .filter((name) => name !== "seal_release_child_evidence")
        .toSorted(),
    );
  });

  it("keeps unavailable reuse metadata from changing workload qualification", () => {
    const workflow = parse(
      readFileSync(".github/workflows/full-release-child-evidence.yml", "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          "continue-on-error"?: boolean;
          steps: Array<{ name: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    expect(workflow.jobs.seal?.["continue-on-error"]).toBe(true);
    const upload = workflow.jobs.seal?.steps.find(
      (step) => step.name === "Upload sealed child evidence",
    );
    expect(upload?.with?.overwrite).toBe(false);
  });

  it.each(["success", "failure"])(
    "seals %s workload facts independently of the parent",
    (conclusion) => {
      const data = fixture();
      data.jobs[1]!.conclusion = conclusion;
      const { result, receipt, output } = seal(data);
      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(readFileSync(receipt, "utf8"));
      expect(evidence).toMatchObject({
        schema: "openclaw.full-release-child-evidence/v1",
        sourceParentRunId: "77",
        sourceParentAttempt: 1,
        runId: "101",
        plannedRunAttempt: 1,
        effectiveRunAttempt: 1,
        role: "normalCi",
        targetSha: TARGET,
        workflowSha: TARGET,
        workloadConclusion: conclusion,
        inputs: { release_scope: "full", target_ref: TARGET },
        publisher: { jobId: "3", jobName: PUBLISHER },
      });
      expect(evidence.jobs.map((job: { name: string }) => job.name)).toEqual([
        "node tests",
        "resolve target",
      ]);
      const { sha256, ...payload } = evidence;
      expect(sha256).toBe(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
      expect(readFileSync(output, "utf8")).toBe(
        `artifact_name=full-release-child-evidence-${TARGET}-normalCi-101-1\n`,
      );
    },
  );

  it.each(["pluginPrereleaseIndependent", "releaseChecksCandidate"])(
    "seals %s evidence at the exact target SHA",
    (role) => {
      const { result, receipt } = seal(fixture(role));
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
        role,
        targetSha: TARGET,
        workflowSha: TARGET,
      });
    },
  );

  it.each([
    { runAttempt: 2, retryWorkload: true, observedRunAttempts: [1, 2], accepted: 2 },
    { runAttempt: 3, retryWorkload: false, observedRunAttempts: [1, 2, 3], accepted: 1 },
  ])(
    "composes attempt $runAttempt with workload retry=$retryWorkload and excludes publishers",
    ({ runAttempt, retryWorkload, observedRunAttempts, accepted }) => {
      const data = fixture();
      data.run.run_attempt = runAttempt;
      data.run.triggering_actor.login = "release-maintainer";
      data.jobs[2]!.status = "completed";
      data.jobs[2]!.conclusion = retryWorkload ? "success" : "failure";
      if (retryWorkload) {
        data.jobs[1]!.conclusion = "failure";
      }
      for (let attempt = 2; attempt <= runAttempt; attempt += 1) {
        data.attempts.push([
          ...(retryWorkload
            ? [{ ...data.jobs[1]!, run_attempt: attempt, conclusion: "success" }]
            : []),
          {
            ...data.jobs[2]!,
            id: attempt + 2,
            run_attempt: attempt,
            status: attempt === runAttempt ? "in_progress" : "completed",
            conclusion: attempt === runAttempt ? null : "failure",
          },
        ]);
      }
      const { result, receipt } = seal(data, runAttempt);
      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(readFileSync(receipt, "utf8"));
      expect(evidence).toMatchObject({
        workloadConclusion: "success",
        effectiveRunAttempt: runAttempt,
        triggeringActor: "release-maintainer",
        publisher: { jobId: String(runAttempt + 2) },
      });
      expect(evidence.observedRunAttempts).toEqual(observedRunAttempts);
      expect(
        evidence.jobs.map((job: { name: string; acceptedRunAttempt: number }) => [
          job.name,
          job.acceptedRunAttempt,
        ]),
      ).toEqual([
        ["node tests", accepted],
        ["resolve target", 1],
      ]);
    },
  );

  it.each([
    {
      name: "workflow SHA different from the target",
      mutate: (data: ReturnType<typeof fixture>) => {
        data.run.head_sha = SHA;
      },
      error: "does not match the target SHA",
    },
    {
      name: "stale run attempt",
      mutate: (data: ReturnType<typeof fixture>) => {
        data.run.run_attempt = 2;
      },
      error: "current active workflow attempt",
    },
    {
      name: "foreign child repository",
      mutate: (data: ReturnType<typeof fixture>) => {
        data.run.repository.full_name = "other/repository";
      },
      error: "provenance changed",
    },
    {
      name: "active predecessor",
      mutate: (data: ReturnType<typeof fixture>) => {
        data.jobs[1]!.status = "in_progress";
      },
      error: "predecessor jobs are active",
    },
    {
      name: "ambiguous publisher",
      mutate: (data: ReturnType<typeof fixture>) => {
        data.jobs.push({ ...data.jobs[2]!, id: 4 });
      },
      error: "publisher job identity",
    },
  ])("rejects $name", ({ mutate, error }) => {
    const data = fixture();
    mutate(data);
    const { result } = seal(data);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });
});
