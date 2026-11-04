import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  releaseChildSpec,
  releaseChildSpecs,
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
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
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
  const page = Number(new URL("https://example.invalid/" + endpoint).searchParams.get("page") ?? 1);
  process.stdout.write(JSON.stringify({total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100)}));
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

function sealed(data = fixture(), runAttempt = 1) {
  const { result, receipt, output } = seal(data, runAttempt);
  expect(result.status, result.stderr).toBe(0);
  return { evidence: JSON.parse(readFileSync(receipt, "utf8")), output };
}

describe("full release child evidence producer", () => {
  it("waits for every workload job before sealing any release child", () => {
    for (const filename of new Set(releaseChildSpecs().map((spec) => spec.workflow))) {
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
    }
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

  it.each([
    ["normalCi", "success"],
    ["normalCi", "failure"],
  ])("seals %s %s workload facts independently of the parent", (role, conclusion) => {
    const data = fixture(role);
    data.jobs[1]!.conclusion = conclusion;
    const { evidence, output } = sealed(data);
    expect(evidence).toMatchObject({
      schema: "openclaw.full-release-child-evidence/v1",
      sourceParentRunId: "77",
      sourceParentAttempt: 1,
      runId: "101",
      plannedRunAttempt: 1,
      effectiveRunAttempt: 1,
      role,
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
      `artifact_name=full-release-child-evidence-${TARGET}-${role}-101-1\n`,
    );
  });

  it("seals a complete paginated attempt without a monolithic metadata response", () => {
    const data = fixture();
    for (let index = 0; index < 100; index++) {
      data.jobs.push({ ...data.jobs[1]!, id: index + 10, name: `workload ${index}` });
    }
    const { evidence } = sealed(data);
    expect(evidence).toMatchObject({ workloadConclusion: "success", observedRunAttempts: [1] });
    expect(evidence.jobs).toHaveLength(102);
  });

  it("composes retried workloads with retained jobs and excludes publishers", () => {
    const data = fixture();
    data.run.run_attempt = 2;
    data.run.status = "queued";
    data.run.triggering_actor.login = "release-maintainer";
    data.jobs[2]!.status = "completed";
    data.jobs[2]!.conclusion = "failure";
    data.jobs[1]!.conclusion = "failure";
    data.attempts.push([
      { ...data.jobs[1]!, run_attempt: 2, conclusion: "success" },
      { ...data.jobs[2]!, id: 4, run_attempt: 2, status: "in_progress", conclusion: null },
    ]);
    const { evidence } = sealed(data, 2);
    expect(evidence).toMatchObject({
      workloadConclusion: "success",
      effectiveRunAttempt: 2,
      triggeringActor: "release-maintainer",
      publisher: { jobId: "4" },
    });
    expect(evidence.observedRunAttempts).toEqual([1, 2]);
    expect(
      evidence.jobs.map((job: { name: string; acceptedRunAttempt: number }) => [
        job.name,
        job.acceptedRunAttempt,
      ]),
    ).toEqual([
      ["node tests", 2],
      ["resolve target", 1],
    ]);
  });

  it.each<[string, (data: ReturnType<typeof fixture>) => void, string]>([
    [
      "workflow SHA different from the target",
      (data) => void (data.run.head_sha = SHA),
      "does not match the target SHA",
    ],
    [
      "stale run attempt",
      (data) => void (data.run.run_attempt = 2),
      "current active workflow attempt",
    ],
    [
      "completed aggregate with an active publisher",
      (data) => void (data.run.status = "completed"),
      "current active workflow attempt",
    ],
    [
      "queued aggregate with an inactive publisher",
      (data) => {
        data.run.status = "queued";
        data.jobs[2]!.status = "queued";
      },
      "publisher job identity",
    ],
    [
      "foreign child repository",
      (data) => void (data.run.repository.full_name = "other/repository"),
      "provenance changed",
    ],
    [
      "active predecessor",
      (data) => void (data.jobs[1]!.status = "in_progress"),
      "predecessor jobs are active",
    ],
    [
      "ambiguous publisher",
      (data) => void data.jobs.push({ ...data.jobs[2]!, id: 4 }),
      "publisher job identity",
    ],
  ])("rejects %s", (_name, mutate, error) => {
    const data = fixture();
    mutate(data);
    const { result } = seal(data);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });
});
