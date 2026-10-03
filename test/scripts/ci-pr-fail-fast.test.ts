import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorPrFailure } from "../../scripts/ci-pr-fail-fast.mjs";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const repository = "openclaw/openclaw";
const headSha = "a".repeat(40);
const run = {
  id: 100,
  run_attempt: 1,
  workflow_id: 22,
  run_number: 500,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  status: "in_progress",
  head_sha: headSha,
  head_branch: "fixture",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};
const pull = {
  state: "open",
  draft: false,
  auto_merge: null as object | null,
  changed_files: 1,
  head: { sha: headSha, ref: "fixture", repo: { full_name: repository } },
  base: { ref: "main", repo: { full_name: repository } },
};
const job = (id: number, conclusion: string | null = "success", name = `row-${id}`) => ({
  id,
  run_id: 100,
  run_attempt: 1,
  name,
  conclusion,
  status: conclusion === null ? "in_progress" : "completed",
  completed_at: conclusion ? "2026-09-23T00:01:00Z" : null,
  started_at: new Date().toISOString(),
});

type Job = ReturnType<typeof job> & { steps?: unknown };

function plannedChecks(count: number): Job {
  return {
    ...job(70, "success", "check-plan"),
    steps: readCiWorkflow()
      .jobs["check-plan"].steps.filter((step: WorkflowStep) =>
        step.name?.startsWith("CI check job count"),
      )
      .map((step: WorkflowStep) => ({
        name: step.name!.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
          String(
            evaluateWorkflowExpression(expression, {
              eventName: "pull_request",
              repository,
              runAttempt: 1,
              steps: { plan: { outputs: { check_job_count: String(count) } } },
            }),
          ),
        ),
        status: "completed",
        conclusion: "success",
      })),
  };
}

function fixture(
  options: {
    jobs?: Job[];
    headRepository?: string;
    preflightCheckJobCount?: number;
    checkPlanExpected?: boolean;
    currentPull?: typeof pull;
    currentRun?: typeof run;
    laterRun?: typeof run;
    recentRuns?: (typeof run)[];
    postError?: boolean;
    monitorStartedAt?: string | null;
    evidenceRoutes?: Record<string, unknown>;
  } = {},
) {
  let runReads = 0;
  const events: string[] = [];
  const rows: Job[] = [...(options.jobs ?? [job(1), job(2), job(3, "failure"), job(4, null)])];
  if (!rows.some((row) => row.name === "pr-fail-fast")) {
    rows.push(job(999, null, "pr-fail-fast"));
  }
  const apiRows = () =>
    rows.map((row) =>
      row.name === "pr-fail-fast" && options.monitorStartedAt !== undefined
        ? { ...row, started_at: options.monitorStartedAt }
        : row,
    );
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const route = new URL(url).pathname.replace(`/repos/${repository}`, "");
    if (init?.method === "POST") {
      events.push(`POST ${route}`);
      if (options.postError) {
        throw new Error("simulated response loss");
      }
      return new Response(null, { status: 202 });
    }
    let body: unknown;
    if (route === "/actions/runs/100") {
      body =
        runReads++ > 0
          ? (options.laterRun ?? options.currentRun ?? run)
          : (options.currentRun ?? run);
    } else if (route === "/pulls/7") {
      body = options.currentPull ?? pull;
    } else if (route === "/actions/workflows/22/runs") {
      body = { workflow_runs: options.recentRuns ?? [run] };
    } else if (route === "/actions/runs/100/attempts/1/jobs") {
      const page = Number(new URL(url).searchParams.get("page"));
      body = { total_count: rows.length, jobs: apiRows().slice((page - 1) * 100, page * 100) };
    } else if (route in (options.evidenceRoutes ?? {})) {
      body = options.evidenceRoutes![route];
      if (typeof body === "string") {
        return new Response(body);
      }
    } else {
      throw new Error(`Unexpected API route: ${route}`);
    }
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetchMock);
  const recordFailure = vi.fn((failed: { id: number; name: string }) => {
    events.push(`cause ${failed.id}`);
  });
  const recordKnownMainRed = vi.fn();
  return {
    events,
    rows,
    fetchMock,
    recordFailure,
    recordKnownMainRed,
    monitor: (expectedJobCount = 4, runAttempt = 1) =>
      monitorPrFailure({
        repository,
        headRepository: options.headRepository,
        headSha,
        runId: 100,
        runAttempt,
        pullRequestNumber: 7,
        expectedJobCount,
        preflightCheckJobCount: options.preflightCheckJobCount ?? 0,
        checkPlanExpected: options.checkPlanExpected ?? false,
        token: "synthetic-test-token",
        recordFailure,
        recordKnownMainRed,
      }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PR failure monitor", () => {
  it.each([
    { pending: 1, plannerReady: true, missing: false, fast: true },
    { pending: 3, plannerReady: true, missing: false, fast: true },
    { pending: 4, plannerReady: true, missing: false, fast: false },
    { pending: 1, plannerReady: false, missing: false, fast: false },
    { pending: 1, plannerReady: true, missing: true, fast: false },
  ])("polls promptly only when the final inventory is present: %j", async (scenario) => {
    vi.useFakeTimers();
    const waiting = Array.from({ length: scenario.pending }, (_, index) => job(index + 10, null));
    const planner = scenario.plannerReady ? plannedChecks(0) : job(70, null, "check-plan");
    const f = fixture({
      jobs: [job(1), job(2), planner, ...waiting, job(90, "skipped")],
      checkPlanExpected: true,
    });
    let completion: string | undefined;
    const monitor = f.monitor(3 + scenario.pending + Number(scenario.missing)).then((reason) => {
      completion = reason;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    if (scenario.pending === 1 && scenario.plannerReady && !scenario.missing) {
      await monitor;
      expect(completion).toBe("last-job-remaining");
      expect(waiting[0]?.status).toBe("in_progress");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.fetchMock).toHaveBeenCalledTimes(2);
      expect(f.events).toEqual([]);
      return;
    }
    expect(completion).toBeUndefined();
    for (const row of waiting) {
      Object.assign(row, job(row.id));
    }
    Object.assign(planner, plannedChecks(0));
    if (scenario.missing) {
      f.rows.push(job(80));
    }
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(completion).toBe(scenario.fast ? "completed" : undefined);
    if (!scenario.fast) {
      await vi.advanceTimersByTimeAsync(25_000);
    }
    await monitor;
    expect(completion).toBe("completed");
    expect(f.events).toEqual([]);
  });

  it("bounds extra API reads when the last jobs take more than a minute", async () => {
    vi.useFakeTimers();
    const last = job(3, null);
    const sibling = job(4, null);
    const f = fixture({
      jobs: [job(1), job(2), last, sibling, plannedChecks(0)],
      checkPlanExpected: true,
    });
    let completion: string | undefined;
    const monitor = f.monitor(5).then((reason) => {
      completion = reason;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(completion).toBeUndefined();
    expect(f.fetchMock).toHaveBeenCalledTimes(14);
    Object.assign(last, job(3));
    Object.assign(sibling, job(4));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.fetchMock).toHaveBeenCalledTimes(14);
    await vi.advanceTimersByTimeAsync(1);
    await monitor;
    expect(completion).toBe("completed");
    expect(f.events).toEqual([]);
  });

  it("retains failure cancellation authority during the final observation cadence", async () => {
    vi.useFakeTimers();
    const last = job(3, null);
    const f = fixture({
      jobs: [job(1), job(2), last, job(4, null), plannedChecks(0)],
      checkPlanExpected: true,
    });
    let completion: string | undefined;
    const monitor = f.monitor(5).then((reason) => {
      completion = reason;
    });
    await vi.advanceTimersByTimeAsync(0);
    Object.assign(last, job(3, "failure"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(completion).toBe("failure-cancelled");
    await monitor;
    expect(f.events).toEqual(["cause 3", "POST /actions/runs/100/cancel"]);
  });

  it.each(
    [repository, "contributor/openclaw"].flatMap((headRepository) =>
      [3, 4]
        .flatMap((expectedJobs) =>
          ["success", "cancelled", "neutral", "action_required", "stale"].map((result) => ({
            headRepository,
            expectedJobs,
            result,
            late: false,
          })),
        )
        .concat({ headRepository, expectedJobs: 4, result: "success", late: true }),
    ),
  )(
    "publishes complete main-red evidence for $headRepository only after a successful sibling ($result, declared=$expectedJobs, late=$late)",
    async ({ headRepository, result, expectedJobs, late }) => {
      vi.useFakeTimers();
      const mainSha = "b".repeat(40);
      const baseSha = "c".repeat(40);
      const file = "src/gateway/example.test.ts";
      const log = `[shard:gateway] [test] starting test/vitest/vitest.gateway.config.ts
[shard:gateway] FAIL gateway ${file} > startup > recovers
[shard:gateway] AssertionError: expected true to be false
[shard:gateway] Test Files 1 failed (1)
[shard:gateway] Tests 1 failed | 2 passed (3)
[shard:gateway] [test] failed 1 Vitest shard in 1s
[shard:gateway] [test] FAILED (exit 1)
[shard:completion] {"version":1,"planned":1,"completed":1,"invocations":1,"failedInvocations":1}`;
      const failed = {
        ...job(3, late ? null : "failure", "checks-node-compact-small-1"),
        steps: [{ name: "Run Node test shard", conclusion: "failure" }],
      };
      const mainRun = {
        ...run,
        id: 200,
        head_branch: "main",
        head_sha: mainSha,
        status: "completed",
        conclusion: "failure",
        event: "schedule",
      };
      const sibling = job(4, late ? "success" : null);
      const f = fixture({
        headRepository,
        currentRun: { ...run, head_repository: { full_name: headRepository } },
        currentPull: { ...pull, head: { ...pull.head, repo: { full_name: headRepository } } },
        jobs: [job(1), job(2), failed, sibling],
        evidenceRoutes: {
          "/actions/workflows/ci.yml/runs": { workflow_runs: [mainRun] },
          "/pulls/7/files": [{ filename: "src/channels/unrelated.ts" }],
          "/git/ref/heads/main": { object: { sha: mainSha } },
          [`/compare/${mainSha}...${headSha}`]: { merge_base_commit: { sha: baseSha } },
          [`/compare/${baseSha}...${mainSha}`]: { status: "ahead" },
          "/actions/runs/200/attempts/1/jobs": {
            total_count: 1,
            jobs: [{ ...failed, id: 20, run_id: 200, status: "completed", conclusion: "failure" }],
          },
          "/actions/jobs/20/logs": log,
          "/actions/jobs/3/logs": log,
          [`/contents/${file}`]: {
            type: "file",
            encoding: "base64",
            content: Buffer.from('import "./subject.js"').toString("base64"),
          },
        },
      });
      const running = f.monitor(expectedJobs);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events).toEqual([]);
      expect(f.recordKnownMainRed).not.toHaveBeenCalled();
      Object.assign(failed, job(3, "failure", "checks-node-compact-small-1"));
      Object.assign(sibling, job(4, result));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await running).toBe(
        result === "success"
          ? "completed"
          : result === "cancelled"
            ? "externally-cancelled"
            : "unclassified-result",
      );
      expect(f.events).toEqual([]);
      if (result === "success") {
        expect(f.recordKnownMainRed).toHaveBeenCalledWith([{ id: 3, mainRunId: 200 }]);
      } else {
        expect(f.recordKnownMainRed).not.toHaveBeenCalled();
      }
    },
  );

  it("never cancels a PR with auto-merge enabled", async () => {
    const f = fixture({ currentPull: { ...pull, auto_merge: {} } });
    expect(await f.monitor()).toBe("superseded");
    expect(f.events).toEqual([]);
  });
  it("replaces the early check reservation with the completed planner's exact count", async () => {
    vi.useFakeTimers();
    const f = fixture({
      jobs: [job(1), job(2), plannedChecks(2), job(10), job(11)],
      preflightCheckJobCount: 4,
      checkPlanExpected: true,
    });
    let completion: string | undefined;
    void f.monitor(7).then((reason) => {
      completion = reason;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(completion).toBe("completed");
    expect(f.events).toEqual([]);
  });

  it("waits for the planner's successful fact before declaring a partially expanded graph complete", async () => {
    vi.useFakeTimers();
    const f = fixture({
      jobs: [job(1), job(2)],
      preflightCheckJobCount: 0,
      checkPlanExpected: true,
    });
    let completion: string | undefined;
    void f.monitor(2).then((reason) => {
      completion = reason;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(completion).toBeUndefined();
    f.rows.push(job(3, "failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(completion).toBe("failure-cancelled");
  });
  it.each([
    { name: "absent marker", steps: [] },
    {
      name: "malformed count",
      steps: [{ name: "CI check job count v1: -1", status: "completed", conclusion: "success" }],
    },
    {
      name: "unbounded count",
      steps: [{ name: "CI check job count v1: 401", status: "completed", conclusion: "success" }],
    },
    {
      name: "wrong version",
      steps: [{ name: "CI check job count v2: 1", status: "completed", conclusion: "success" }],
    },
    {
      name: "unfinished marker",
      steps: [{ name: "CI check job count v1: 1", status: "in_progress", conclusion: null }],
    },
    {
      name: "failed marker",
      steps: [{ name: "CI check job count v1: 1", status: "completed", conclusion: "failure" }],
    },
    {
      name: "duplicate marker",
      steps: [
        { name: "CI check job count v1: 1", status: "completed", conclusion: "success" },
        { name: "CI check job count v1: 1", status: "completed", conclusion: "success" },
      ],
    },
  ])("does not treat a terminal planner's $name as clean completion", async ({ steps }) => {
    const f = fixture({
      jobs: [job(1), job(2), { ...plannedChecks(1), steps }, job(10)],
      preflightCheckJobCount: 1,
      checkPlanExpected: true,
    });
    await expect(f.monitor()).rejects.toThrow("count fact");
    expect(f.events).toEqual([]);
  });

  it.each(["queued", "malformed", "failed"] as const)(
    "observes failures without waiting for a %s planner",
    async (type) => {
      const planner =
        type === "queued"
          ? job(70, null, "check-plan")
          : type === "failed"
            ? job(70, "failure", "check-plan")
            : { ...plannedChecks(1), steps: [] };
      const f = fixture({
        jobs: [job(1), job(2, "failure"), planner],
        preflightCheckJobCount: 1,
        checkPlanExpected: true,
      });
      expect(await f.monitor()).toBe("failure-cancelled");
      expect(f.events).toEqual(["cause 2", "POST /actions/runs/100/cancel"]);
    },
  );

  it.each(["duplicate", "wrong attempt"] as const)(
    "rejects a %s planner identity",
    async (type) => {
      const planner = plannedChecks(0);
      const f = fixture({
        jobs: [
          job(1),
          job(2),
          planner,
          type === "duplicate"
            ? { ...plannedChecks(0), id: 71 }
            : { ...plannedChecks(0), id: 71, run_attempt: 2 },
        ],
        preflightCheckJobCount: 1,
        checkPlanExpected: true,
      });
      await expect(f.monitor()).rejects.toThrow(
        type === "duplicate" ? "multiple check planners" : "identity changed",
      );
      expect(f.events).toEqual([]);
    },
  );

  it("accepts a valid zero-row final plan", async () => {
    const f = fixture({
      jobs: [job(1), job(2), plannedChecks(0)],
      preflightCheckJobCount: 1,
      checkPlanExpected: true,
    });
    expect(await f.monitor()).toBe("completed");
    expect(f.events).toEqual([]);
  });

  it.each([
    ["2026-09-23T00:00:00Z", "observation-expired"],
    [null, "observation-unavailable"],
  ])("accounts for setup time before observing (%s)", async (monitorStartedAt, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:55:00Z"));
    const f = fixture({ jobs: [job(1), job(2, null)], monitorStartedAt });
    let completion: string | undefined;
    void f.monitor().then((reason) => {
      completion = reason;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(completion).toBe(expected);
    expect(f.events).toEqual([]);
  });

  it("cancels the current run while GitHub still reports it queued", async () => {
    const f = fixture({ currentRun: { ...run, status: "queued" } });
    expect(await f.monitor()).toBe("failure-cancelled");
    expect(f.events).toEqual(["cause 3", "POST /actions/runs/100/cancel"]);
  });
  it("skips partial reruns without cancelling or waiting for cached jobs", async () => {
    const f = fixture({ jobs: [job(3)] });
    expect(await f.monitor(100, 2)).toBe("retry");
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
  it("records the failed row before cancelling only its own attempt's run", async () => {
    const f = fixture({ jobs: [job(1), job(2), job(3, "failure"), job(4, "cancelled")] });
    expect(await f.monitor()).toBe("failure-cancelled");
    expect(f.recordFailure).toHaveBeenCalledWith({ id: 3, name: "row-3", runAttempt: 1 });
    expect(f.events).toEqual(["cause 3", "POST /actions/runs/100/cancel"]);
  });

  it("retains the failure cause when the cancellation response is lost, without retrying", async () => {
    const f = fixture({ postError: true });
    await expect(f.monitor()).rejects.toThrow("simulated response loss");
    expect(f.events).toEqual(["cause 3", "POST /actions/runs/100/cancel"]);
  });

  it.each(["push", "workflow_dispatch"])("never cancels a %s run", async (event) => {
    const f = fixture({ currentRun: { ...run, event } });
    await expect(f.monitor()).rejects.toThrow("identity changed");
    expect(f.events).toEqual([]);
  });

  it("rejects an unexpected fork repository before observing its run", async () => {
    const f = fixture({
      currentRun: { ...run, head_repository: { full_name: "contributor/openclaw" } },
    });
    await expect(f.monitor()).rejects.toThrow("identity changed");
    expect(f.events).toEqual([]);
  });

  it("observes an unknown fork failure without requesting cancellation or recording a cancel cause", async () => {
    const headRepository = "contributor/openclaw";
    const f = fixture({
      headRepository,
      currentRun: { ...run, head_repository: { full_name: headRepository } },
      currentPull: { ...pull, head: { ...pull.head, repo: { full_name: headRepository } } },
    });
    expect(await f.monitor()).toBe("failure-observed");
    expect(f.events).toEqual([]);
    expect(f.recordFailure).not.toHaveBeenCalled();
    expect(f.recordKnownMainRed).not.toHaveBeenCalled();
  });

  it("rejects changed live fork ownership without writing", async () => {
    const headRepository = "contributor/openclaw";
    const f = fixture({
      headRepository,
      currentRun: { ...run, head_repository: { full_name: headRepository } },
      currentPull: { ...pull, head: { ...pull.head, repo: { full_name: "another/openclaw" } } },
    });
    expect(await f.monitor()).toBe("superseded");
    expect(f.events).toEqual([]);
  });

  it.each(["new head", "draft", "closed", "same-head newer run", "new attempt"])(
    "preserves superseding work (%s)",
    async (change) => {
      const f = fixture({
        currentPull: {
          ...pull,
          state: change === "closed" ? "closed" : "open",
          draft: change === "draft",
          head: { ...pull.head, sha: change === "new head" ? "b".repeat(40) : headSha },
        },
        recentRuns:
          change === "same-head newer run" ? [{ ...run, id: 101, run_number: 501 }] : [run],
        laterRun: change === "new attempt" ? { ...run, run_attempt: 2 } : run,
      });
      expect(await f.monitor()).toBe("superseded");
      expect(f.events).toEqual([]);
    },
  );

  it("does not record a failure for externally cancelled rows", async () => {
    const f = fixture({ jobs: [job(1), job(2), job(3, "cancelled")] });
    expect(await f.monitor()).toBe("externally-cancelled");
    expect(f.events).toEqual([]);
  });

  it("waits for all selected jobs to appear before declaring success", async () => {
    vi.useFakeTimers();
    const f = fixture({ jobs: [job(1), job(2)] });
    const monitor = f.monitor(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    f.rows.push(job(3, "failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await monitor).toBe("failure-cancelled");
  });

  it("finds a failure beyond the first job page", async () => {
    const f = fixture({
      jobs: Array.from({ length: 101 }, (_, i) => job(i + 1, i === 100 ? "failure" : "success")),
    });
    expect(await f.monitor(101)).toBe("failure-cancelled");
    expect(f.recordFailure).toHaveBeenCalledWith({ id: 101, name: "row-101", runAttempt: 1 });
  });

  it("finishes a successful selected graph without waiting on its own gate", async () => {
    const f = fixture({
      jobs: [
        job(1),
        job(2),
        job(3),
        job(4, null, "pr-fail-fast"),
        job(5, null, "openclaw/ci-gate"),
      ],
    });
    expect(await f.monitor(3)).toBe("completed");
    expect(f.events).toEqual([]);
  });
});
