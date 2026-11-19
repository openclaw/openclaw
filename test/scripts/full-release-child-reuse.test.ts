import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseChildSpec } from "../../scripts/full-release-validation-policy.mjs";
import { canonicalizeJsonValue } from "../../scripts/lib/canonical-json.mjs";
import { releaseChildDispatchInputs } from "../../scripts/lib/full-release-child-request.mjs";
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

async function fixture(
  role = "normalCi",
  dispatchInputs?: Record<string, string>,
  workflowSha = TOOLING,
  workloadJobCount = 2,
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
    run_attempt: 1,
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
    effectiveRunAttempt: 1,
    plannedRunAttempt: 1,
    jobs: jobs.slice(0, -1).map((job) => ({
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
  const attempts = [jobs];
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
      if (endpoint.startsWith("contents/scripts/lib/release-validation-waivers.json?ref=")) {
        const bytes = readFileSync("scripts/lib/release-validation-waivers.json");
        return {
          type: "file",
          path: "scripts/lib/release-validation-waivers.json",
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
          sha: createHash("sha1")
            .update("blob " + bytes.length + "\0")
            .update(bytes)
            .digest("hex"),
        };
      }
      if (endpoint.startsWith("actions/runs/101/artifacts?")) {
        return { total_count: 1, artifacts: [artifact] };
      }
      if (/^actions\/runs\/[0-9]+\/artifacts\?/u.test(endpoint)) {
        return { total_count: 0, artifacts: [] };
      }
      const attempt =
        /^actions\/runs\/101\/attempts\/([1-9][0-9]*)\/jobs\?per_page=100&page=1$/u.exec(endpoint);
      if (attempt) {
        const attemptJobs = attempts[Number(attempt[1]) - 1]!;
        return { total_count: attemptJobs.length, jobs: attemptJobs };
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

function crossQualificationTrees(data: Awaited<ReturnType<typeof fixture>>) {
  const next = "c".repeat(40);
  const entry = (path: string, sha: string, type = "blob") => ({
    path,
    sha,
    type,
    mode: type === "tree" ? "040000" : "100644",
  });
  const tree = (sha: string, entries: ReturnType<typeof entry>[]) => ({
    sha,
    truncated: false,
    tree: entries,
  });
  const previousRoot = "1".repeat(40);
  const nextRoot = "2".repeat(40);
  const previousGithub = "3".repeat(40);
  const nextGithub = "4".repeat(40);
  const previousWorkflows = "5".repeat(40);
  const nextWorkflows = "6".repeat(40);
  const stable = "7".repeat(40);
  const blobResponses: Record<string, unknown> = {};
  const blob = (source: string) => {
    const bytes = Buffer.from(source);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    blobResponses[`git/blobs/${sha}`] = {
      sha,
      size: bytes.length,
      encoding: "base64",
      content: bytes.toString("base64"),
    };
    return sha;
  };
  const workflowBlob = blob("jobs:\n  checks:\n    uses: ./.github/workflows/shared.yml\n");
  const sharedBlob = blob("jobs:\n  checks:\n    runs-on: ubuntu-latest\n");
  const previous = tree(previousRoot, [
    entry("scripts", stable, "tree"),
    ...["config", "packages", "src", "test"].map((path) => entry(path, stable, "tree")),
    entry("pnpm-lock.yaml", stable),
    entry(".github", previousGithub, "tree"),
  ]);
  const current = tree(nextRoot, [
    entry("scripts", stable, "tree"),
    ...["config", "packages", "src", "test"].map((path) => entry(path, stable, "tree")),
    entry("pnpm-lock.yaml", stable),
    entry(".github", nextGithub, "tree"),
  ]);
  const previousActions = tree(previousGithub, [
    entry("actions", stable, "tree"),
    entry("workflows", previousWorkflows, "tree"),
  ]);
  const currentActions = tree(nextGithub, [
    entry("actions", stable, "tree"),
    entry("workflows", nextWorkflows, "tree"),
  ]);
  const previousWorkflow = tree(previousWorkflows, [
    entry(releaseChildSpec(data.request.role).workflow, workflowBlob),
    entry("shared.yml", sharedBlob),
    entry("full-release-validation.yml", "8".repeat(40)),
  ]);
  const currentWorkflow = tree(nextWorkflows, [
    entry(releaseChildSpec(data.request.role).workflow, workflowBlob),
    entry("shared.yml", sharedBlob),
    entry("full-release-validation.yml", (data.request.role === "normalCi" ? "9" : "8").repeat(40)),
  ]);
  const responses: Record<string, unknown> = {
    ["compare/" + data.request.workflowSha + "..." + next + "?per_page=1"]: {
      status: "ahead",
      merge_base_commit: { sha: data.request.workflowSha },
      files: [{ filename: ".github/workflows/full-release-validation.yml", status: "modified" }],
    },
    [`git/commits/${data.request.workflowSha}`]: {
      sha: data.request.workflowSha,
      tree: { sha: previousRoot },
    },
    [`git/commits/${next}`]: { sha: next, tree: { sha: nextRoot } },
    [`git/trees/${previousRoot}`]: previous,
    [`git/trees/${nextRoot}`]: current,
    [`git/trees/${previousGithub}`]: previousActions,
    [`git/trees/${nextGithub}`]: currentActions,
    [`git/trees/${previousWorkflows}`]: previousWorkflow,
    [`git/trees/${nextWorkflows}`]: currentWorkflow,
  };
  const github = data.deps.github;
  data.deps.github = async (endpoint) =>
    blobResponses[endpoint] ?? responses[endpoint] ?? github(endpoint);
  data.request.workflowSha = next;
  return { current, currentActions, currentWorkflow, previousWorkflow, blob };
}

describe("independent release child reuse", () => {
  it.each(["success", "failure"])(
    "reuses raw %s execution after a Q-only grant commit",
    async (conclusion) => {
      const data = await fixture("normalCi", undefined, TOOLING, 3);
      const version = "2099.1.1";
      const nextQ = "c".repeat(40);
      const trees = crossQualificationTrees(data);
      // A real waiver commit changes the scripts tree, while execution is unchanged.
      trees.current.tree.find((entry) => entry.path === "scripts")!.sha = "e".repeat(40);
      data.request.workflowSha = TOOLING;
      data.run.conclusion = conclusion;
      data.artifact.expires_at = "2099-01-01T00:00:00Z";
      data.jobs[0]!.name = "a synthetic failing test";
      data.jobs[1]!.name = "b synthetic aggregate";
      data.jobs[1]!.steps = [{ name: "Check synthetic results", status: "completed", conclusion }];
      for (const job of data.jobs.slice(0, 2)) {
        job.conclusion = conclusion;
      }
      data.receipt.workloadConclusion = conclusion;
      data.receipt.jobs = data.receipt.jobs.map((job, index) => ({
        ...job,
        name: data.jobs[index]!.name,
        conclusion: data.jobs[index]!.conclusion,
      }));
      data.receipt.compositeJobsSha256 = jsonDigest({
        effectiveRunAttempt: 1,
        plannedRunAttempt: 1,
        jobs: data.receipt.jobs,
      });
      await data.seal();
      const originalBytes = JSON.stringify(data.receipt);
      const policy = { schema: "openclaw.release-validation-waivers/v1", waivers: [] as unknown[] };
      const github = data.deps.github;
      data.deps.github = async (endpoint) => {
        if (endpoint.startsWith("contents/scripts/lib/release-validation-waivers.json?ref=")) {
          const bytes = Buffer.from(JSON.stringify(policy));
          return {
            type: "file",
            path: "scripts/lib/release-validation-waivers.json",
            encoding: "base64",
            size: bytes.length,
            content: bytes.toString("base64"),
            sha: createHash("sha1")
              .update("blob " + bytes.length + "\0")
              .update(bytes)
              .digest("hex"),
          };
        }
        if (endpoint === "compare/" + TOOLING + "..." + nextQ + "?per_page=1") {
          return {
            status: "ahead",
            merge_base_commit: { sha: TOOLING },
            files: [
              { filename: "scripts/lib/release-validation-waivers.json", status: "modified" },
            ],
          };
        }
        return github(endpoint);
      };
      const responses: Record<string, unknown> = {};
      const deps = {
        ...data.deps,
        github: async (endpoint: string) => {
          const response = await data.deps.github(endpoint);
          responses[endpoint] = response;
          return response;
        },
        getJobLog: async () => "##[error]synthetic test failed",
      };
      const initial = await discoverReusableReleaseChild(
        { ...data.request, policyTargetVersion: version },
        deps,
      );
      expect(initial === null, data.deps.report.mock.calls.flat().join("\n")).toBe(
        conclusion === "failure",
      );
      policy.waivers.push({
        targetVersion: version,
        targetSha: TARGET,
        childRole: "normalCi",
        jobName: "a synthetic failing test",
        reason: "Synthetic operator approval",
        aggregates: [
          {
            jobName: "b synthetic aggregate",
            stepName: "Check synthetic results",
            causes: ["synthetic test failed"],
            exactCauses: true,
          },
        ],
      });
      const request = { ...data.request, workflowSha: nextQ, policyTargetVersion: version };
      const selected = await discoverReusableReleaseChild(request, deps);
      expect(selected, data.deps.report.mock.calls.flat().join("\n")).toMatchObject({
        runId: "101",
        workflowSha: TOOLING,
        targetSha: TARGET,
      });
      const reused = await validateReusableReleaseChild(selected, request, deps);
      expect(reused.run.conclusion).toBe(conclusion);
      expect(JSON.stringify(reused.receipt)).toBe(originalBytes);
      expect(reused.jobs.find((job) => job.name === "workload 3")?.conclusion).toBe("success");
      if (conclusion === "failure") {
        // Exercise the workflow entrypoint and its real gh/ZIP transport, not only helpers.
        const directory = tempDirs.make("q-waiver-rerun-");
        const archive = await data.deps.downloadArchive();
        responses["actions/artifacts/301"] = data.artifact;
        writeFileSync(join(directory, "responses.json"), JSON.stringify(responses));
        writeFileSync(join(directory, "receipt.zip"), archive.archiveBytes);
        writeFileSync(
          join(directory, "ci.yml"),
          "on:\n  workflow_dispatch:\n    inputs:\n      target_ref:\n        type: string\n      release_scope:\n        type: string\n",
        );
        writeFileSync(
          join(directory, "gh"),
          `#!${process.execPath}
const fs = require("node:fs");
const endpoint = process.argv[3].replace("repos/openclaw/openclaw/", "");
if (endpoint === "actions/artifacts/301/zip") process.stdout.write(fs.readFileSync(__dirname + "/receipt.zip"));
else if (endpoint === "actions/jobs/2/logs") process.stdout.write("##[error]synthetic test failed");
else {
 const responses = JSON.parse(fs.readFileSync(__dirname + "/responses.json", "utf8"));
 if (!(endpoint in responses)) { console.error("Unexpected fixture endpoint: " + endpoint); process.exit(2); }
 process.stdout.write(JSON.stringify(responses[endpoint]));
}
`,
        );
        chmodSync(join(directory, "gh"), 0o755);
        const outputPath = join(directory, "output");
        const cli = spawnSync(
          process.execPath,
          [
            "scripts/find-reusable-release-child.mjs",
            "ci.yml",
            "-f",
            "target_ref=" + TARGET,
            "-f",
            "release_scope=full",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: directory + delimiter + process.env.PATH,
              GH_TOKEN: "",
              GITHUB_TOKEN: "",
              CHILD_WORKFLOW_KIND: "ci",
              CHILD_WORKFLOW_DIRECTORY: directory,
              GITHUB_REPOSITORY: REPOSITORY,
              TARGET_SHA: TARGET,
              TARGET_VERSION: version,
              PARENT_WORKFLOW_SHA: nextQ,
              GITHUB_RUN_ID: "900",
              GITHUB_OUTPUT: outputPath,
            },
          },
        );
        expect(cli.status, cli.stderr).toBe(0);
        expect(cli.stdout).toContain("Reused ci.yml:");
        expect(readFileSync(outputPath, "utf8")).toContain("run_id=101\nrun_attempt=1");
        await expect(
          validateReusableReleaseChild(selected, request, {
            ...deps,
            github: async (endpoint) =>
              endpoint === "compare/" + TOOLING + "..." + nextQ + "?per_page=1"
                ? {
                    status: "ahead",
                    merge_base_commit: { sha: TOOLING },
                    files: [
                      {
                        filename: "scripts/lib/release-validation-waivers.json",
                        status: "modified",
                      },
                      { filename: "scripts/changed-execution.mjs", status: "modified" },
                    ],
                  }
                : deps.github(endpoint),
          }),
        ).rejects.toThrow("workload closure changed");
        await expect(
          validateReusableReleaseChild(selected, request, {
            ...deps,
            getJobLog: async () => "##[error]artifact integrity failed",
          }),
        ).rejects.toThrow("unwaived failure");
        policy.waivers = [];
        expect(await discoverReusableReleaseChild(request, deps)).toBeNull();
      }
    },
  );
  it("retains original C-owned child identity across a parent-only Q repair", async () => {
    const data = await fixture("normalCi", undefined, TARGET);
    crossQualificationTrees(data);
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection).toMatchObject({
      workflowSha: TARGET,
      runId: "101",
      receiptSha256: data.receipt.sha256,
    });
    await expect(
      validateReusableReleaseChild(selection, data.request, data.deps),
    ).resolves.toMatchObject({
      receipt: { workflowSha: TARGET, targetSha: TARGET },
    });
    // Equivalence does not allow changing the target or normalized child inputs.
    await expect(
      validateReusableReleaseChild(selection, { ...data.request, targetSha: TOOLING }, data.deps),
    ).rejects.toThrow("selection identity");
    await expect(
      validateReusableReleaseChild(
        selection,
        { ...data.request, inputs: { ...data.request.inputs, release_scope: "changed" } },
        data.deps,
      ),
    ).rejects.toThrow("selection identity");
  });

  it.each([
    "scripts",
    "config",
    "packages",
    "src",
    "test",
    "dependencies",
    "actions",
    "child workflow",
    "transitive workflow",
    "truncated inventory",
    "wrong tree identity",
  ])("invalidates cross-Q evidence when %s changes", async (changed) => {
    const data = await fixture("normalCi", undefined, TARGET);
    const trees = crossQualificationTrees(data);
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection).not.toBeNull();
    if (changed === "truncated inventory") {
      trees.current.truncated = true;
    } else if (changed === "wrong tree identity") {
      trees.current.sha = "e".repeat(40);
    } else {
      const entries =
        changed === "actions"
          ? trees.currentActions.tree
          : ["child workflow", "transitive workflow"].includes(changed)
            ? trees.currentWorkflow.tree
            : trees.current.tree;
      const path =
        changed === "dependencies"
          ? "pnpm-lock.yaml"
          : changed === "transitive workflow"
            ? "shared.yml"
            : changed === "child workflow"
              ? "ci.yml"
              : changed;
      entries.find((entry) => entry.path === path)!.sha = [
        "child workflow",
        "transitive workflow",
      ].includes(changed)
        ? trees.blob("jobs:\n  changed:\n    runs-on: ubuntu-latest\n")
        : "d".repeat(40);
    }
    await expect(validateReusableReleaseChild(selection, data.request, data.deps)).rejects.toThrow(
      ["truncated inventory", "wrong tree identity"].includes(changed)
        ? "incomplete or invalid"
        : "workload closure changed",
    );
    expect(await discoverReusableReleaseChild(data.request, data.deps)).toBeNull();
  });
  it("invalidates script-dispatched workflow changes without guessing script dependencies", async () => {
    const data = await fixture("releaseChecksIndependent", undefined, TARGET);
    const trees = crossQualificationTrees(data);
    const descendant = {
      path: "qa-telegram.yml",
      sha: "e".repeat(40),
      type: "blob",
      mode: "100644",
    };
    trees.previousWorkflow.tree.push(descendant);
    trees.currentWorkflow.tree.push({ ...descendant });
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection).not.toBeNull();
    trees.currentWorkflow.tree.find((entry) => entry.path === descendant.path)!.sha = "f".repeat(
      40,
    );
    await expect(validateReusableReleaseChild(selection, data.request, data.deps)).rejects.toThrow(
      "workload closure changed",
    );
    expect(await discoverReusableReleaseChild(data.request, data.deps)).toBeNull();
  });

  it("ignores unrelated Q product and workflow changes but fails closed on unknown dependencies", async () => {
    const data = await fixture("normalCi", undefined, TARGET);
    const trees = crossQualificationTrees(data);
    trees.current.tree.push({ path: "apps", sha: "e".repeat(40), type: "tree", mode: "040000" });
    trees.currentWorkflow.tree.push({
      path: "other.yml",
      sha: "f".repeat(40),
      type: "blob",
      mode: "100644",
    });
    const selection = await discoverReusableReleaseChild(data.request, data.deps);
    expect(selection).not.toBeNull();
    trees.currentWorkflow.tree.find((entry) => entry.path === "ci.yml")!.sha = trees.blob(
      "jobs:\n  checks:\n    uses: *unresolved\n",
    );
    await expect(validateReusableReleaseChild(selection, data.request, data.deps)).rejects.toThrow(
      "unsupported reusable workflow reference",
    );
  });

  it.each([
    "normalCi",
    "pluginPrereleaseIndependent",
    "releaseChecksIndependent",
    "productPerformance",
    "npmTelegram",
  ])("recognizes the real %s workflow closure", async (role) => {
    const data = await fixture(role, undefined, TARGET);
    const trees = crossQualificationTrees(data);
    const workflows = readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/u.test(name))
      .map((name) => ({
        path: name,
        sha: trees.blob(readFileSync(join(".github/workflows", name), "utf8")),
        type: "blob",
        mode: "100644",
      }));
    trees.currentWorkflow.tree = workflows;
    trees.previousWorkflow.tree = workflows;
    expect(await discoverReusableReleaseChild(data.request, data.deps)).not.toBeNull();
  });

  it("reuses a Q-policy-waived receipt through the default log reader", async () => {
    const version = "2099.1.1";
    const targetSha = TARGET;
    const jobName = "a synthetic failing test";
    const data = await fixture();
    data.request.targetSha = data.receipt.targetSha = targetSha;
    data.request.inputs.target_ref = data.receipt.inputs.target_ref = targetSha;
    data.artifact.name = data.artifact.name.replace(TARGET, targetSha);
    await data.seal();
    const original = await discoverReusableReleaseChild(data.request, data.deps);
    if (!original) {
      throw new Error("expected original reusable receipt");
    }
    data.run.conclusion = "failure";
    data.jobs[0]!.name = jobName;
    data.jobs[1]!.name = "openclaw/ci-gate";
    for (const job of data.jobs.slice(0, 2)) {
      job.conclusion = "failure";
    }
    data.jobs[1]!.steps = [
      {
        name: "Verify selected CI lanes",
        status: "completed",
        conclusion: "failure",
      },
    ];
    data.receipt.workloadConclusion = "failure";
    data.receipt.jobs = data.receipt.jobs.map((job, index) => ({
      ...job,
      name: data.jobs[index]!.name,
      conclusion: "failure",
    }));
    data.receipt.compositeJobsSha256 = jsonDigest({
      effectiveRunAttempt: data.receipt.effectiveRunAttempt,
      plannedRunAttempt: data.receipt.plannedRunAttempt,
      jobs: data.receipt.jobs,
    });
    await data.seal();
    const selection = {
      ...original,
      receiptSha256: data.receipt.sha256,
      artifact: {
        ...original.artifact,
        digest: data.artifact.digest,
        sizeInBytes: data.artifact.size_in_bytes,
      },
    };
    const root = tempDirs.make("frv-waiver-log-");
    writeFileSync(join(root, "package.json"), '{"type":"commonjs"}\n');
    const gh = join(root, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
if (process.argv.slice(2).join(" ") !== "api repos/openclaw/openclaw/actions/jobs/2/logs --allow-escape-sequences") process.exit(2);
process.stdout.write("##[error]checks-node-core-test-nondist-shard finished with failure (selected=true)");
`,
    );
    chmodSync(gh, 0o755);
    vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH ?? ""}`);
    const github = data.deps.github;
    const deps = {
      ...data.deps,
      github: async (endpoint: string) => {
        if (!endpoint.startsWith("contents/scripts/lib/release-validation-waivers.json?ref=")) {
          return github(endpoint);
        }
        const bytes = Buffer.from(
          JSON.stringify({
            schema: "openclaw.release-validation-waivers/v1",
            waivers: [
              {
                targetVersion: version,
                targetSha,
                childRole: "normalCi",
                jobName,
                reason: "Synthetic operator approval",
                aggregates: [
                  {
                    jobName: "openclaw/ci-gate",
                    stepName: "Verify selected CI lanes",
                    causes: [
                      "checks-node-core-test-nondist-shard finished with failure (selected=true)",
                    ],
                    exactCauses: true,
                  },
                ],
              },
            ],
          }),
        );
        return {
          type: "file",
          path: "scripts/lib/release-validation-waivers.json",
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
          sha: createHash("sha1")
            .update("blob " + bytes.length + "\0")
            .update(bytes)
            .digest("hex"),
        };
      },
    };
    await expect(validateReusableReleaseChild(selection, data.request, deps)).rejects.toThrow(
      "current successful attempt",
    );
    const recovered = await validateReusableReleaseChild(
      selection,
      {
        ...data.request,
        policyTargetVersion: version,
      },
      deps,
    );
    expect(recovered.run.conclusion).toBe("failure");
    expect(recovered.receipt.workloadConclusion).toBe("failure");
    expect(await discoverReusableReleaseChild(data.request, deps)).toBeNull();
    expect(
      await discoverReusableReleaseChild({ ...data.request, policyTargetVersion: version }, deps),
    ).toMatchObject({ runId: String(data.run.id), receiptSha256: data.receipt.sha256 });
    await expect(
      validateReusableReleaseChild(
        selection,
        {
          ...data.request,
          policyTargetVersion: version,
        },
        { ...deps, getJobLog: async () => "##[error]artifact integrity failed" },
      ),
    ).rejects.toThrow("unwaived failure");
    await expect(
      validateReusableReleaseChild(
        selection,
        {
          ...data.request,
          policyTargetVersion: "2099.1.2",
        },
        deps,
      ),
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
    { workflowSha: "c".repeat(40), reason: "Full release child evidence API GET" },
  ])(
    "rejects invalid or unavailable current-parent tooling: $reason",
    async ({ workflowSha, reason }) => {
      const data = await fixture();
      const selection = await discoverReusableReleaseChild(data.request, data.deps);
      data.request.workflowSha = workflowSha;
      const github = data.deps.github;
      data.deps.github = async (endpoint) => {
        if (endpoint.startsWith("git/commits/") || endpoint.startsWith("compare/")) {
          throw new Error("Full release child evidence API GET: commit unavailable");
        }
        return github(endpoint);
      };
      await expect(
        validateReusableReleaseChild(selection, data.request, data.deps),
      ).rejects.toThrow(reason);
      if (!workflowSha) {
        await expect(discoverReusableReleaseChild(data.request, data.deps)).rejects.toThrow(reason);
        return;
      }
      expect(await discoverReusableReleaseChild(data.request, data.deps)).toBeNull();
      expect(data.deps.report).toHaveBeenCalledWith(
        expect.stringContaining(
          `run 101 ${data.run.display_title}: rejected: Full release child evidence API GET`,
        ),
      );
      expect(data.deps.report).toHaveBeenCalledWith(
        expect.stringContaining("evaluated 1; dispatching fresh work; skipped {}"),
      );
    },
  );

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
