import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { readWorkflow } from "./ci-workflow.test-support.js";

async function recover(
  options: {
    failure?: "test" | "other-provider" | "other-error";
    currentHead?: string;
    nextAttempt?: number;
    event?: string;
    quotaMessage?: string;
  } = {},
) {
  const run = {
    id: 42,
    path: ".github/workflows/ci.yml",
    repository: { full_name: "openclaw/openclaw" },
    head_repository: { full_name: "openclaw/openclaw" },
    head_sha: "current",
    head_branch: "feature",
    event: options.event ?? "pull_request",
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    pull_requests: [],
  };
  const jobs = [
    {
      name: "checks-node-core",
      conclusion: "failure",
      labels: [options.failure === "other-provider" ? "ubuntu-24.04" : "boat-large"],
      steps: [
        {
          name: options.failure === "test" ? "Run tests" : "Set up runner",
          conclusion: "failure",
        },
      ],
      check_run_url: "https://api.github.com/repos/openclaw/openclaw/check-runs/7",
    },
    { name: "openclaw/ci-gate", conclusion: "failure", labels: [], steps: [], check_run_url: "" },
  ];
  const annotations = [
    {
      title: "Paused by plan limit",
      message:
        options.failure === "other-error"
          ? "Unknown error"
          : (options.quotaMessage ??
            "You used all 2,400 sandbox starts included in the last 24 hours."),
    },
  ];
  let reads = 0;
  const retries: unknown[] = [];
  const workflow = readWorkflow(".github/workflows/ci-boat-recovery.yml");
  const script = workflow.jobs.recover.steps[0].with.script;
  await runInNewContext(`(async () => { ${script}\n })()`, {
    context: { repo: { owner: "openclaw", repo: "openclaw" }, payload: { workflow_run: run } },
    core: { info() {} },
    github: {
      rest: {
        actions: {
          getWorkflowRun: async () => ({
            data: { ...run, run_attempt: ++reads > 1 ? (options.nextAttempt ?? 1) : 1 },
          }),
          listJobsForWorkflowRunAttempt: "jobs",
          reRunWorkflowFailedJobs: async (args: unknown) => {
            retries.push(args);
          },
        },
        checks: { listAnnotations: "annotations" },
        pulls: {
          list: async () => ({
            data: [{ head: { repo: run.repository, sha: options.currentHead ?? "current" } }],
          }),
        },
        repos: {
          getBranch: async () => ({ data: { commit: { sha: options.currentHead ?? "current" } } }),
        },
      },
      paginate: async (route: string) => (route === "jobs" ? jobs : annotations),
    },
  });
  return retries;
}

it("recovers an actual quota setup signature when the run omits pull request metadata", async () => {
  expect(await recover()).toEqual([{ owner: "openclaw", repo: "openclaw", run_id: 42 }]);
  expect(await recover({ event: "push" })).toHaveLength(1);
  expect(await recover({ quotaMessage: "Hourly sandbox starts limit reached." })).toHaveLength(1);
  expect(await recover({ quotaMessage: "Sandbox starts per minute limit reached." })).toHaveLength(
    1,
  );
});

it("does not turn test failures or stale CI into automatic retries", async () => {
  for (const options of [
    { failure: "test" as const },
    { failure: "other-provider" as const },
    { failure: "other-error" as const },
    { quotaMessage: "You used all included VM hours." },
    { currentHead: "newer" },
    { event: "push", currentHead: "newer" },
    { nextAttempt: 2 },
  ]) {
    expect(await recover(options), JSON.stringify(options)).toEqual([]);
  }
});
