import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
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

function runGate(runs: WorkflowRun[]) {
  const root = tempDirs.make("docs-agent-gate-");
  const { write } = files(root);
  const bin = join(root, "bin");
  const output = join(root, "output");
  write("output", "");
  const owner = join(root, "owner.py");
  fs.copyFileSync(".github/actions/git-owner/owner.py", owner);
  // Only the gate runs. Git/network and the clock are fixtures; jq executes the real filters.
  const commands = {
    git: `if [ "$1" = "-C" ]; then shift 2; fi
case "$*" in
  'fetch --no-tags origin main') ;;
  'rev-parse origin/main'|'rev-parse HEAD') printf '%s\\n' '${mainSha}' ;;
  'rev-parse ${mainSha}^') printf '%s\\n' '${parentSha}' ;;
  'cat-file -e ${previousSha}^{commit}'|'cat-file -e ${parentSha}^{commit}') ;;
  *) printf 'Unexpected git call: %s\\n' "$*" >&2; exit 1 ;;
esac`,
    gh: `case "$*" in
  *'/attempts/'*) printf '%s\\n' "$DOCS_AGENT_JOBS_FIXTURE" | jq -c --arg endpoint "$*" '
    . as $jobs | ($endpoint | capture("runs/(?<id>[0-9]+)/attempts/(?<attempt>[0-9]+)/jobs")) as $key
    | $jobs[($key.id + ":" + $key.attempt)] // error("Unexpected jobs request")' ;;
  *) printf '%s\\n' "$DOCS_AGENT_RUNS_FIXTURE" ;;
esac`,
    date: `printf '%s\\n' '2026-08-28T22:30:00Z'`,
  };
  for (const [name, script] of Object.entries(commands)) {
    write(`bin/${name}`, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  const jobs = runs.map((run) => {
    const step = {
      name: "Run Codex docs agent",
      status: run.status,
      conclusion: run.writer ? "skipped" : run.conclusion,
    };
    const job = {
      ...step,
      name: "update-docs",
      conclusion: run.writer === "denied" ? "skipped" : run.conclusion,
      steps: [step],
    };
    return [`${run.id}:${run.run_attempt}`, [{ jobs: [job] }]];
  });
  const result = runShell(root, workflowScript("id", "gate"), {
    PATH: `${bin}:${process.env.PATH}`,
    CI_GIT_OWNER: owner,
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_RUN_ID: String(currentRun.id),
    EVENT_NAME: "workflow_run",
    WORKFLOW_HEAD_SHA: mainSha,
    DOCS_AGENT_RUNS_FIXTURE: JSON.stringify({ workflow_runs: runs }),
    DOCS_AGENT_JOBS_FIXTURE: JSON.stringify(Object.fromEntries(jobs)),
  });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return { stdout: result.stdout, output: fs.readFileSync(output, "utf8") };
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
      write(
        "CHANGELOG.md",
        "# Changelog\n\n## 2026.9.4\n\nReleased notes.\n\n### Complete contribution record\n\n- Original accounting.\n\n## 2026.8.1\n\nHistorical notes.\n",
      );
      runNode("release-changelog", { root }, "split");
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

  it("does not let the current REST run throttle itself", () => {
    const result = runGate([currentRun]);
    expect(result.output).toBe(admittedOutput(parentSha));
    expect(result.stdout).not.toContain("skipping");
  });

  it.each([
    ["queued", "queued", null],
    ["in progress", "in_progress", null],
    ["completed", "completed", "success"],
    ["failed", "completed", "failure"],
  ])("throttles another %s run and prints its REST id", (_label, status, conclusion) => {
    const other = { ...currentRun, id: 122, status, conclusion, head_sha: previousSha };
    const result = runGate([currentRun, other]);
    expect(result.output).toBe("run_agent=false\n");
    expect(result.stdout).toContain("already ran or is running within the last hour");
    expect(result.stdout).toContain(
      [other.id, status, conclusion ?? "", other.created_at, previousSha].join("\t"),
    );
    expect(result.stdout).not.toContain("123\t");
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
  it.each([
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
  ])("does not let $name throttle admission or advance the review base", ({ runs }) => {
    expect(runGate(runs).output).toBe(admittedOutput(previousSha));
  });
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
