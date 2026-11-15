import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import { evaluateWorkflowExpression, readCiWorkflow } from "./ci-workflow.test-support.js";
import { files } from "./docs-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflow = parse(fs.readFileSync(".github/workflows/docs-agent.yml", "utf8"));
const writerJob = workflow.jobs["update-docs"];
function workflowScript(key: "id" | "name", value: string): string {
  return writerJob.steps.find((step: { id?: string; name?: string }) => step[key] === value).run;
}
function runShell(root: string, script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      RUNNER_TEMP: root,
      CI_GIT_OWNER: resolve(".github/actions/git-owner/owner.py"),
      ...env,
    },
  });
}
const runNode = (script: string, options: Record<string, string>, ...args: string[]) =>
  execFileSync(process.execPath, [
    resolve(`scripts/${script}.mjs`),
    ...args,
    ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]),
  ]);
const mainSha = "a".repeat(40);
const parentSha = "b".repeat(40);
const previousSha = "c".repeat(40);
const currentRun = {
  id: 123,
  run_attempt: 1,
  created_at: "2026-08-28T23:00:00Z",
  status: "in_progress",
  conclusion: null,
  head_sha: mainSha,
};
type WorkflowRun = Omit<typeof currentRun, "conclusion"> & {
  conclusion: string | null;
  writer?: "denied" | "gated";
};

async function runGate(runs: WorkflowRun[], signal: AbortSignal) {
  const report = await runCiGitStep({
    signal,
    workflow: {
      file: ".github/workflows/docs-agent.yml",
      job: "update-docs",
      step: "Gate trusted main activity and hourly cadence",
    },
    fetchResults: [],
    revisions: { "origin/main": mainSha, [`${mainSha}^`]: parentSha },
    commandResults: Object.fromEntries(
      [previousSha, parentSha].map((sha) => [`cat-file -e ${sha}^{commit}`, { code: 0 }]),
    ),
    env: {
      EVENT_NAME: "workflow_run",
      WORKFLOW_HEAD_SHA: mainSha,
      GITHUB_RUN_ID: String(currentRun.id),
    },
    workflowRuns: runs,
    workflowJobs: runs.map((run) => ({
      runId: run.id,
      runAttempt: run.run_attempt,
      jobs: [
        {
          name: "update-docs",
          status: run.status,
          conclusion: run.writer === "denied" ? "skipped" : run.conclusion,
          steps: [
            {
              name: "Run Codex docs agent",
              status: run.status,
              conclusion: run.writer ? "skipped" : run.conclusion,
            },
          ],
        },
      ],
    })),
  });
  expect(report.code, report.output).toBe(0);
  return { stdout: report.output, output: report.githubOutput };
}
function admittedOutput(reviewBase: string) {
  return [
    "run_agent=true",
    `base_sha=${mainSha}`,
    `review_base_sha=${reviewBase}`,
    `review_head_sha=${mainSha}`,
    "",
  ].join("\n");
}

describe.skipIf(process.platform === "win32")("Docs Agent gate", () => {
  it.each(
    ["mirror", "initial", "record", "independent edit"]
      .flatMap((change) => [false, true].map((staged) => ({ change, staged })))
      .concat([
        { change: "index-only record", staged: true },
        { change: "index-only source", staged: true },
      ]),
  )(
    "admits only an exact regeneration of an existing docs mirror ($change, staged=$staged)",
    ({ change, staged }) => {
      const root = tempDirs.make("docs-agent-mirror-");
      const { write } = files(root);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
      const mirrorPath = join(root, "CHANGELOG/2026.9.4.md");
      const docsPath = join(root, "docs/releases/2026.9.4.md");
      const sourcePath = join(root, "src/example.js");
      const originalSource = "export const value = 1;\n";
      write("src/example.js", originalSource);
      fs.symlinkSync(resolve("scripts"), join(root, "scripts"), "dir");
      write("CHANGELOG/2026.8.1.md", "## 2026.8.1\n\nHistorical notes.\n");
      write("CHANGELOG/records/2026.9.4.md", "## 2026.9.4\n\nFrozen contribution record.\n");
      write("docs/releases/2026.9.4.md", "# Release notes\n\nApproved source prose.\n");
      const regenerate = () =>
        runNode("render-release-changelog", {
          root,
          version: "2026.9.4",
          source: "docs/releases/2026.9.4.md",
          output: mirrorPath,
        });
      regenerate();
      const recordPath = join(root, "CHANGELOG/records/2026.9.4.md");
      const originalRecord = fs.readFileSync(recordPath, "utf8");
      git("init", "-q");
      git("add", ".");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
      if (change === "mirror") {
        fs.appendFileSync(docsPath, "\nCorrected source detail.\n");
        regenerate();
      } else if (change === "initial") {
        fs.appendFileSync(join(root, "CHANGELOG/2026.8.1.md"), "Changed history.\n");
      } else if (change === "record" || change === "index-only record") {
        fs.appendFileSync(recordPath, "Changed accounting.\n");
      } else if (change === "index-only source") {
        fs.writeFileSync(sourcePath, "export const value = 2;\n");
      } else {
        fs.appendFileSync(mirrorPath, "Unapproved independent prose.\n");
      }
      if (staged) {
        git("add", ".");
      }
      if (change === "index-only record") {
        fs.writeFileSync(recordPath, originalRecord);
      } else if (change === "index-only source") {
        fs.writeFileSync(sourcePath, originalSource);
      }
      const result = runShell(root, workflowScript("name", "Enforce existing-docs-only patch"));
      expect(result.status, result.stdout + result.stderr).toBe(change === "mirror" ? 0 : 1);
    },
  );

  it("does not let the current REST run throttle itself", async ({ signal }) => {
    const result = await runGate([currentRun], signal);
    expect(result.output).toBe(admittedOutput(parentSha));
  });

  it.for([
    ["queued", "queued", null],
    ["in progress", "in_progress", null],
    ["completed", "completed", "success"],
    ["failed", "completed", "failure"],
  ] as const)("throttles another %s run", async ([_label, status, conclusion], { signal }) => {
    const other = { ...currentRun, id: 122, status, conclusion, head_sha: previousSha };
    const result = await runGate([currentRun, other], signal);
    expect(result.output).toBe("run_agent=false\n");
  });

  const completedRun = (changes: Partial<WorkflowRun>): WorkflowRun => ({
    ...currentRun,
    id: 122,
    status: "completed",
    conclusion: "success",
    head_sha: parentSha,
    ...changes,
  });
  const reviewedRun = completedRun({
    id: 121,
    created_at: "2026-08-28T21:00:00Z",
    head_sha: previousSha,
  });
  const history = (changes: Partial<WorkflowRun>, reviewed = reviewedRun): WorkflowRun[] => [
    currentRun,
    completedRun(changes),
    reviewed,
  ];
  const writers: NonNullable<WorkflowRun["writer"]>[] = ["denied", "gated"];
  it.for([
    {
      name: "the current id with an older REST snapshot",
      runs: [
        { ...currentRun, created_at: "2026-08-28T21:00:00Z", head_sha: parentSha },
        completedRun({ created_at: "2026-08-28T20:00:00Z", head_sha: previousSha }),
      ],
    },
    ...[
      ["skipped", currentRun.created_at],
      ["cancelled", currentRun.created_at],
      ["cancelled", "2026-08-28T22:29:59Z"],
    ].map(([conclusion, created_at]) => ({
      name: `${conclusion} history from ${created_at}`,
      runs: history(
        { conclusion, created_at },
        { ...reviewedRun, created_at: "2026-08-28T22:29:58Z" },
      ),
    })),
    ...writers.flatMap((writer) =>
      [currentRun.created_at, "2026-08-28T22:29:59Z"].map((created_at) => ({
        name: `${writer} hourly attempt from ${created_at}`,
        runs: history({ run_attempt: 2, created_at, writer }),
      })),
    ),
    {
      name: "an unsuccessful agent attempt",
      runs: history({ created_at: "2026-08-28T22:29:59Z", conclusion: "failure" }),
    },
  ])(
    "does not let $name throttle admission or advance the review base",
    async ({ runs }, { signal }) => {
      expect((await runGate(runs, signal)).output).toBe(admittedOutput(previousSha));
    },
  );
});

describe("Docs Agent full-CI admission", () => {
  const verify = workflow.jobs["verify-ci"];
  const repo = { owner: "openclaw", repo: "openclaw" };
  const confirmedStep = "Confirm validated workflow revision";
  const source = {
    id: 456,
    run_attempt: 2,
    event: "schedule",
    display_title: "CI",
    path: ".github/workflows/ci.yml",
    head_branch: "main",
    head_sha: mainSha,
    status: "completed",
    conclusion: "success",
    actor: { login: "github-actions[bot]" },
    repository: { full_name: "openclaw/openclaw" },
    head_repository: { full_name: "openclaw/openclaw" },
  };
  const confirmedGate = {
    name: "openclaw/ci-gate",
    head_sha: mainSha,
    conclusion: "success",
    steps: [{ name: confirmedStep, conclusion: "success" }],
  };
  const evaluate = (value: string, context: Parameters<typeof evaluateWorkflowExpression>[1]) =>
    evaluateWorkflowExpression(value.startsWith("${{") ? value : "${{ " + value + " }}", context);

  type AdmissionOptions = {
    event?: Partial<typeof source>;
    observedRun?: Partial<typeof source>;
    latestRun?: Partial<typeof source>;
    currentMain?: string;
    jobs?: (typeof confirmedGate)[];
    ciOnPush?: string;
    manual?: boolean;
    actor?: string;
    apiFails?: boolean;
  };
  async function admit(options: AdmissionOptions = {}) {
    const event = { ...source, ...options.event };
    const run = { ...event, ...options.observedRun };
    const outputs: Record<string, string> = { allowed: "false" };
    const context = {
      repository: "openclaw/openclaw",
      runAttempt: 1,
      eventName: options.manual ? ("workflow_dispatch" as const) : ("workflow_run" as const),
      actor: options.actor ?? "github-actions[bot]",
      githubEvent: { workflow_run: event },
      ciOnPush: options.ciOnPush ?? "",
    };
    const getWorkflowRun = vi
      .fn<() => Promise<{ data: typeof run }>>()
      .mockResolvedValueOnce({ data: run })
      .mockResolvedValue({ data: { ...run, ...options.latestRun } });
    if (options.apiFails) {
      getWorkflowRun.mockReset().mockRejectedValue(new Error("GitHub unavailable"));
    }
    const getBranch = async () => ({ data: { commit: { sha: options.currentMain ?? mainSha } } });
    const listJobsForWorkflowRunAttempt = vi.fn();
    const paginate = vi.fn(async () => options.jobs ?? [confirmedGate]);
    const actions = { getWorkflowRun, listJobsForWorkflowRunAttempt };
    const rest = { actions, repos: { getBranch } };
    if (evaluate(verify.if, context)) {
      await runInNewContext("(async () => {" + verify.steps[0].with.script + "})()", {
        context: { eventName: context.eventName, repo, payload: { workflow_run: event } },
        github: { rest, paginate },
        core: {
          setOutput: (key: string, value: string) => {
            outputs[key] = value;
          },
          info() {},
        },
      });
    }
    const allowed = evaluate(writerJob.if, {
      ...context,
      additionalNeeds: { "verify-ci": { outputs } },
    });
    return { allowed, getWorkflowRun, paginate, listJobsForWorkflowRunAttempt };
  }

  const fullPush: AdmissionOptions = {
    ciOnPush: "true",
    event: { event: "push", actor: { login: "maintainer" } },
  };
  const admissionCases: [string, AdmissionOptions, boolean][] = [
    ["a successful exact-attempt scheduled run", {}, true],
    ["an opted-in full main push", fullPush, true],
    ["explicit non-bot Docs Agent manual admission", { manual: true, actor: "maintainer" }, true],
    ["bot Docs Agent manual admission", { manual: true }, false],
  ];
  it.each(admissionCases)("applies admission policy to %s", async (_name, options, allowed) => {
    const result = await admit(options);
    expect(result.allowed).toBe(allowed);
    if (options.manual) {
      expect(result.getWorkflowRun).not.toHaveBeenCalled();
    } else {
      expect(result.paginate).toHaveBeenCalledExactlyOnceWith(
        result.listJobsForWorkflowRunAttempt,
        {
          owner: "openclaw",
          repo: "openclaw",
          run_id: 456,
          attempt_number: 2,
          per_page: 100,
        },
      );
    }
  });

  it.each([
    { event: "workflow_dispatch", display_title: "CI hourly-main-123-1" },
    { event: "workflow_dispatch", display_title: "CI release validation" },
    { event: "pull_request" },
  ])("rejects unrelated CI completion without reading evidence: %j", async (event) => {
    const result = await admit({ event });
    expect(result.allowed).toBe(false);
    expect(result.getWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not allocate verification or write concurrency for default security-only push completions", async () => {
    const result = await admit({
      event: { event: "push", actor: { login: "maintainer" }, display_title: "CI" },
    });
    expect(result.allowed).toBe(false);
    expect(result.getWorkflowRun).not.toHaveBeenCalled();
    expect({ concurrency: workflow.concurrency, permissions: workflow.permissions }).toEqual({
      concurrency: undefined,
      permissions: { actions: "read", contents: "read" },
    });
    expect({ needs: writerJob.needs, concurrency: writerJob.concurrency }).toEqual({
      needs: "verify-ci",
      concurrency: { group: "docs-agent-main", "cancel-in-progress": false },
    });
  });

  const rejectedEvidence: AdmissionOptions[] = [
    ...["skipped", "failure"].map((conclusion) => ({
      ciOnPush: fullPush.ciOnPush,
      event: fullPush.event,
      jobs: [{ ...confirmedGate, conclusion }],
    })),
    ...[
      { id: 999 },
      { head_sha: previousSha },
      { run_attempt: 3 },
      { path: ".github/workflows/other.yml" },
      { head_branch: "topic" },
      { repository: { full_name: "fork/openclaw" } },
      { head_repository: { full_name: "fork/openclaw" } },
      { status: "in_progress" },
      { conclusion: "failure" },
      { conclusion: "cancelled" },
    ].map((observedRun) => ({ observedRun })),
    ...[
      [],
      [confirmedGate, confirmedGate],
      [{ ...confirmedGate, head_sha: previousSha }],
      [{ ...confirmedGate, steps: [] }],
      [
        {
          ...confirmedGate,
          steps: [{ name: confirmedStep, conclusion: "skipped" }],
        },
      ],
    ].map((jobs) => ({ jobs })),
    { latestRun: { run_attempt: 3, status: "in_progress" } },
    { currentMain: previousSha },
  ];
  it.each(rejectedEvidence)(
    "rejects incomplete, stale, or foreign full-CI evidence %j",
    async (options) => {
      expect((await admit(options)).allowed).toBe(false);
    },
  );

  it("propagates unavailable API evidence", async () => {
    await expect(admit({ apiFails: true })).rejects.toThrow("GitHub unavailable");
  });

  it("confirms only a successful CI aggregate for the validated workflow revision", () => {
    const producer = readCiWorkflow().jobs["ci-gate"].steps.find(
      (step: { name?: string }) => step.name === confirmedStep,
    );
    const context = {
      repository: "openclaw/openclaw",
      eventName: "workflow_dispatch" as const,
      runAttempt: 1,
      sha: mainSha,
      preflightOutputs: { checkout_revision: mainSha, validation_tier: "full" },
      includeAndroid: true,
    };
    expect(evaluate(producer.if, context)).toBe(true);
    for (const change of [
      { failed: true },
      { targetRef: previousSha },
      { releaseGate: true },
      { releaseScope: "npm-beta" },
      { includeAndroid: false },
      { preflightOutputs: { checkout_revision: previousSha, validation_tier: "full" } },
      { preflightOutputs: { checkout_revision: mainSha, validation_tier: "main" } },
    ]) {
      expect(evaluate(producer.if, { ...context, ...change })).toBe(false);
    }
    expect(evaluate(producer.if, { ...context, eventName: "push" })).toBe(true);
    expect(evaluate(producer.if, { ...context, eventName: "pull_request" })).toBe(true);
    expect(
      evaluate(producer.if, {
        ...context,
        eventName: "schedule",
        preflightOutputs: { checkout_revision: mainSha, validation_tier: "main" },
      }),
    ).toBe(false);
    for (const outcome of [{ failed: true }, { cancelled: true }]) {
      expect(evaluate(producer.if, { ...context, eventName: "schedule", ...outcome })).toBe(false);
    }
  });
});
