import { describe, expect, it } from "vitest";
import {
  classifyPrForSweep,
  classifyRunForRevive,
  runPrCiSweeper,
} from "../../scripts/github/pr-ci-sweeper.mjs";
import {
  HOURS,
  MINUTES,
  NOW,
  autoMergePr,
  cancelledRun,
  context,
  core,
  fakeGithub,
  githubActionsCheck,
  pr,
  recordingCore,
} from "./pr-ci-sweeper.test-support.js";

describe("classifyPrForSweep", () => {
  const cases: Array<{
    name: string;
    prOverrides?: Partial<Parameters<typeof classifyPrForSweep>[0]["pr"]>;
    ciRuns?: Parameters<typeof classifyPrForSweep>[0]["ciRuns"];
    botCloseCount?: number;
    expected: ReturnType<typeof classifyPrForSweep>;
  }> = [
    {
      name: "re-fires when no CI run attached",
      expected: { action: "refire", reason: "ci-run-missing" },
    },
    {
      name: "re-fires when only startup failures attached",
      ciRuns: [{ conclusion: "startup_failure" }],
      botCloseCount: 1,
      expected: { action: "refire", reason: "ci-startup-failure" },
    },
    {
      name: "skips drafts",
      prOverrides: { draft: true },
      expected: { action: "skip", reason: "draft" },
    },
    {
      name: "skips recently updated PRs so merge-ref computation can settle",
      prOverrides: { updated_at: new Date(NOW - 5 * MINUTES).toISOString() },
      expected: { action: "skip", reason: "recently-updated" },
    },
    {
      name: "skips merge conflicts whose merge ref legitimately cannot exist",
      prOverrides: { mergeable: false },
      expected: { action: "skip", reason: "merge-conflict" },
    },
    {
      name: "skips PRs with auto-merge enabled (close would cancel it)",
      prOverrides: { auto_merge: { merge_method: "squash" } },
      expected: { action: "skip", reason: "auto-merge-enabled" },
    },
    {
      name: "treats a completed run as attached",
      ciRuns: [{ conclusion: "success" }],
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "treats a queued run (null conclusion) as attached",
      ciRuns: [{ conclusion: null }, { conclusion: "startup_failure" }],
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "treats a failed run as attached (rerunnable, not sweepable)",
      ciRuns: [{ conclusion: "failure" }],
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "stops after two bot closes",
      botCloseCount: 2,
      expected: { action: "skip", reason: "refire-budget-exhausted" },
    },
    {
      name: "re-fires on unknown mergeability (stuck merge-ref IS the pathology)",
      prOverrides: { mergeable: null },
      expected: { action: "refire", reason: "ci-run-missing" },
    },
  ];

  it.each(cases)("$name", ({ prOverrides, ciRuns = [], botCloseCount = 0, expected }) => {
    expect(classifyPrForSweep({ pr: pr(prOverrides), ciRuns, botCloseCount, now: NOW })).toEqual(
      expected,
    );
  });
});

describe("classifyRunForRevive", () => {
  const prCreatedAt = new Date(NOW - 2 * HOURS).toISOString();
  const cases: Array<{
    name: string;
    runOverrides?: Partial<Parameters<typeof classifyRunForRevive>[0]["run"]>;
    pullCreatedAt?: string;
    expectedHeadBranch?: string;
    expectedRepoFullName?: string;
    expected: ReturnType<typeof classifyRunForRevive>;
  }> = [
    {
      name: "revives a cancelled pull_request_target run",
      expected: { action: "revive", reason: "cancelled-pr-event-run" },
    },
    {
      name: "revives a cancelled pull_request run",
      runOverrides: { event: "pull_request" },
      expected: { action: "revive", reason: "cancelled-pr-event-run" },
    },
    {
      name: "skips a run after two revives without progress",
      runOverrides: { event: "pull_request", run_attempt: 3 },
      expected: { action: "skip", reason: "revive-budget-exhausted" },
    },
    {
      name: "skips a non-cancelled run",
      runOverrides: { conclusion: "success" },
      expected: { action: "skip", reason: "not-cancelled" },
    },
    {
      name: "skips a cancelled run from an unrelated event",
      runOverrides: { event: "workflow_dispatch" },
      expected: { action: "skip", reason: "unsupported-event" },
    },
    {
      name: "skips a run triggered from a different head branch",
      runOverrides: { head_branch: "some/other-branch" },
      expected: { action: "skip", reason: "different-head-branch" },
    },
    {
      name: "skips a run with a null head branch",
      runOverrides: { head_branch: null },
      expected: { action: "skip", reason: "different-head-branch" },
    },
    {
      name: "fails closed when the expected and actual head branches are empty",
      runOverrides: { head_branch: "" },
      expectedHeadBranch: "",
      expected: { action: "skip", reason: "different-head-branch" },
    },
    {
      name: "skips a run with no head repository metadata",
      runOverrides: { head_repository: undefined },
      expected: { action: "skip", reason: "fork-head-repository" },
    },
    {
      name: "skips a run whose head repository is a fork",
      runOverrides: { head_repository: { full_name: "fork/openclaw" } },
      expected: { action: "skip", reason: "fork-head-repository" },
    },
    {
      name: "fails closed when the expected and actual head repositories are empty",
      runOverrides: { head_repository: { full_name: "" } },
      expectedRepoFullName: "",
      expected: { action: "skip", reason: "fork-head-repository" },
    },
    {
      name: "skips a run created before the current PR existed",
      runOverrides: { created_at: new Date(NOW - 3 * HOURS).toISOString() },
      expected: { action: "skip", reason: "predates-pr" },
    },
    {
      name: "fails closed when the workflow run creation time is invalid",
      runOverrides: { created_at: "not-a-date" },
      expected: { action: "skip", reason: "unverifiable-created-at" },
    },
    {
      name: "fails closed when the pull request creation time is invalid",
      pullCreatedAt: "not-a-date",
      expected: { action: "skip", reason: "unverifiable-created-at" },
    },
  ];

  it.each(cases)(
    "$name",
    ({
      runOverrides,
      pullCreatedAt = prCreatedAt,
      expectedHeadBranch = "automation/refresh",
      expectedRepoFullName = "openclaw/openclaw",
      expected,
    }) => {
      expect(
        classifyRunForRevive({
          run: cancelledRun(1, runOverrides),
          prCreatedAt: pullCreatedAt,
          prHeadBranch: expectedHeadBranch,
          repoFullName: expectedRepoFullName,
        }),
      ).toEqual(expected);
    },
  );
});

describe("runPrCiSweeper", () => {
  it("classifies a dropped-CI PR as refire in dry-run without mutating", async () => {
    const dropped = {
      ...pr(),
      number: 7,
      state: "open",
      head: { sha: "a".repeat(40) },
    };
    const attached = {
      ...pr(),
      number: 8,
      state: "open",
      head: { sha: "b".repeat(40) },
    };
    const { github, calls } = fakeGithub({
      prs: [dropped, attached],
      runsBySha: {
        [dropped.head.sha]: [{ conclusion: "startup_failure" }],
        [attached.head.sha]: [{ conclusion: "success" }],
      },
    });
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      dryRun: true,
      appSlug: "openclaw-barnacle",
      now: NOW,
    });
    expect(results).toEqual([
      { number: 7, sha: "a".repeat(12), action: "refire", reason: "ci-startup-failure" },
      { number: 8, sha: "b".repeat(12), action: "skip", reason: "ci-attached" },
    ]);
    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
  });

  it.each(["failure", "cancelled", "skipped"])(
    "logs attached %s CI on a non-auto-merge PR without re-firing or reviving it",
    async (conclusion) => {
      const attached = {
        ...pr(),
        number: 21,
        state: "open",
        head: { sha: "5".repeat(40), ref: "automation/refresh" },
      };
      const { github, calls } = fakeGithub({
        prs: [attached],
        runsBySha: {
          [attached.head.sha]: [{ id: 100, status: "completed", conclusion }],
        },
        checksByRef: { [attached.head.sha]: [githubActionsCheck(100, { conclusion })] },
        workflowRunsById: { 100: cancelledRun(100, { event: "pull_request", conclusion }) },
      });
      const { core: loggedCore, logs } = recordingCore();
      const results = await runPrCiSweeper({
        github: github as never,
        context: context as never,
        core: loggedCore as never,
        now: NOW,
      });
      expect(results).toEqual([
        { number: 21, sha: "5".repeat(12), action: "skip", reason: "ci-attached" },
      ]);
      expect(logs).toContain(`pr-ci-sweeper: skip #21 (ci-attached: 100:completed/${conclusion})`);
      expect(
        calls.filter((call) =>
          ["pulls.update", "actions.reRunWorkflow", "issues.createComment"].includes(call.method),
        ),
      ).toEqual([]);
    },
  );

  it("logs draft skips so every scanned PR has a decision", async () => {
    const draft = {
      ...pr({ draft: true }),
      number: 22,
      state: "open",
      head: { sha: "6".repeat(40) },
    };
    const { github, calls } = fakeGithub({ prs: [draft], runsBySha: {} });
    const { core: loggedCore, logs } = recordingCore();
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      now: NOW,
    });
    expect(results).toEqual([{ number: 22, sha: "6".repeat(12), action: "skip", reason: "draft" }]);
    expect(logs).toContain("pr-ci-sweeper: skip #22 (draft)");
    // Drafts skip before the per-head run lookup so they cost no Actions reads.
    expect(calls.filter((call) => call.method === "actions.listWorkflowRuns")).toEqual([]);
  });

  it.each([
    { name: "missing CI", ciRuns: [] },
    { name: "startup_failure-only CI", ciRuns: [{ conclusion: "startup_failure" }] },
  ])("does not re-fire $name when the final PR read becomes draft", async ({ ciRuns }) => {
    const candidate = {
      ...pr(),
      number: 23,
      state: "open",
      head: { sha: "7".repeat(40) },
    };
    const { github, calls } = fakeGithub({
      prs: [candidate],
      runsBySha: { [candidate.head.sha]: ciRuns },
      pullsGetByNumber: {
        [candidate.number]: [candidate, { ...candidate, draft: true }],
      },
    });
    const { core: loggedCore, logs } = recordingCore();

    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
    expect(calls.filter((call) => call.method === "issues.createComment")).toEqual([]);
    expect(results).toEqual([
      { number: 23, sha: "7".repeat(12), action: "skip", reason: "changed-during-sweep" },
    ]);
    expect(logs).toContain("pr-ci-sweeper: #23 changed during sweep; leaving it alone");
    expect(logs.at(-1)).toContain("0 re-fires");
    expect(
      calls
        .filter((call) => call.method === "pulls.get" || call.method === "actions.listWorkflowRuns")
        .map((call) => call.method),
    ).toEqual(["actions.listWorkflowRuns", "pulls.get", "pulls.get"]);
  });

  it("keeps logging decisions after the per-sweep re-fire cap", async () => {
    const dropped = Array.from({ length: 11 }, (_, index) => ({
      ...pr(),
      number: 100 + index,
      state: "open",
      head: { sha: index.toString(16).padStart(2, "0").repeat(20) },
    }));
    const { github, calls } = fakeGithub({ prs: dropped, runsBySha: {} });
    const { core: loggedCore, logs } = recordingCore();
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      dryRun: true,
      now: NOW,
    });
    expect(results.filter((entry) => entry.action === "refire")).toHaveLength(10);
    expect(results.at(-1)).toEqual({
      number: 110,
      sha: "0a".repeat(6),
      action: "skip",
      reason: "refire-cap-reached",
    });
    expect(logs).toContain("pr-ci-sweeper: skip #110 (refire-cap-reached)");
    // The capped PR is classified from list data only, never fetched.
    expect(
      calls.filter((call) => call.method === "pulls.get" && call.args.pull_number === 110),
    ).toEqual([]);
  });

  it("stops listing pages once creation dates cross the lookback", async () => {
    const recent = { ...pr(), number: 30, state: "open", head: { sha: "7".repeat(40) } };
    const oldA = {
      ...pr({ created_at: new Date(NOW - 25 * HOURS).toISOString() }),
      number: 31,
      state: "open",
      head: { sha: "8".repeat(40) },
    };
    const oldB = {
      ...pr({ created_at: new Date(NOW - 30 * HOURS).toISOString() }),
      number: 32,
      state: "open",
      head: { sha: "9".repeat(40) },
    };
    const { github, calls } = fakeGithub({
      prs: [recent, oldA, oldB],
      runsBySha: {},
      pageSize: 1,
    });
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      dryRun: true,
      now: NOW,
    });
    // Page 2 crossed the 24h creation horizon, so page 3 is never fetched and
    // the outside-lookback PR on page 2 stops the scan without a decision.
    expect(calls.filter((call) => call.method === "pulls.list.page")).toHaveLength(2);
    expect(results).toEqual([
      { number: 30, sha: "7".repeat(12), action: "refire", reason: "ci-run-missing" },
    ]);
  });

  it("revives a cancelled GitHub Actions check exactly once", async () => {
    const generated = autoMergePr(10, "d".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        // One workflow produces multiple checks; dedupe their shared run id.
        [generated.head.sha]: [githubActionsCheck(1234), githubActionsCheck(1234)],
      },
      workflowRunsById: { 1234: cancelledRun(1234) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([
      {
        method: "actions.reRunWorkflow",
        args: { owner: "openclaw", repo: "openclaw", run_id: 1234 },
      },
    ]);
    // Discovery plus the pre-mutation revalidation both list the head's checks.
    const checkLists = calls.filter((call) => call.method === "checks.listForRef");
    expect(checkLists).toHaveLength(2);
    for (const call of checkLists) {
      expect(call.args).toEqual({
        owner: "openclaw",
        repo: "openclaw",
        ref: generated.head.sha,
        filter: "latest",
        per_page: 100,
      });
    }
    // Discovery plus the pre-mutation attempt reclassification both fetch the run.
    expect(calls.filter((call) => call.method === "actions.getWorkflowRun")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
  });

  it.each([
    {
      name: "same-name successful",
      replacementName: "proof",
      status: "completed",
      conclusion: "success",
    },
    {
      name: "queued",
      replacementName: "proof",
      status: "queued",
      conclusion: null,
    },
    {
      name: "in-progress",
      replacementName: "proof",
      status: "in_progress",
      conclusion: null,
    },
    {
      name: "renamed",
      replacementName: "renamed proof",
      status: "completed",
      conclusion: "success",
    },
  ])(
    "does not revive a cancelled run superseded by a $name workflow run",
    async ({ replacementName, status, conclusion }) => {
      const generated = autoMergePr(40, "4".repeat(40));
      const { github, calls } = fakeGithub({
        prs: [generated],
        runsBySha: {},
        checksByRef: {
          [generated.head.sha]: [
            githubActionsCheck(100),
            githubActionsCheck(200, { name: replacementName, status, conclusion }),
          ],
        },
        workflowRunsById: {
          100: cancelledRun(100),
          200: cancelledRun(200, { conclusion }),
        },
      });

      await runPrCiSweeper({
        github: github as never,
        context: context as never,
        core: core as never,
        now: NOW,
      });

      expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
    },
  );

  it("does not let a newer run from another workflow suppress a cancelled run", async () => {
    const generated = autoMergePr(41, "5".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, { conclusion: "success" }),
        ],
      },
      workflowRunsById: {
        100: cancelledRun(100),
        200: cancelledRun(200, { workflow_id: 20, conclusion: "success" }),
      },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([
      {
        method: "actions.reRunWorkflow",
        args: { owner: "openclaw", repo: "openclaw", run_id: 100 },
      },
    ]);
    expect(
      calls.filter((call) => call.method === "actions.getWorkflowRun" && call.args.run_id === 200),
    ).toHaveLength(1);
  });

  it.each([
    { name: "manual dispatch", replacement: { event: "workflow_dispatch" } },
    { name: "push event", replacement: { event: "push" } },
    { name: "different pull-request event", replacement: { event: "pull_request" } },
    { name: "different head branch", replacement: { head_branch: "automation/another-pr" } },
    { name: "missing head branch", replacement: { head_branch: null } },
    {
      name: "fork head repository",
      replacement: { head_repository: { full_name: "someone-else/openclaw" } },
    },
    { name: "missing head repository", replacement: { head_repository: undefined } },
    {
      name: "run predating the pull request",
      replacement: { created_at: new Date(NOW - 3 * HOURS).toISOString() },
    },
  ])(
    "does not let a newer $name from the same workflow suppress the PR run",
    async ({ replacement }) => {
      const generated = autoMergePr(48, "c".repeat(40));
      const { github, calls } = fakeGithub({
        prs: [generated],
        runsBySha: {},
        checksByRef: {
          [generated.head.sha]: [
            githubActionsCheck(100),
            githubActionsCheck(200, { conclusion: "success" }),
          ],
        },
        workflowRunsById: {
          100: cancelledRun(100),
          200: cancelledRun(200, { conclusion: "success", ...replacement }),
        },
      });

      await runPrCiSweeper({
        github: github as never,
        context: context as never,
        core: core as never,
        now: NOW,
      });

      expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([
        {
          method: "actions.reRunWorkflow",
          args: { owner: "openclaw", repo: "openclaw", run_id: 100 },
        },
      ]);
      expect(
        calls.filter(
          (call) => call.method === "actions.getWorkflowRun" && call.args.run_id === 200,
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    { name: "successful", status: "completed", conclusion: "success" },
    { name: "queued", status: "queued", conclusion: null },
    { name: "in-progress", status: "in_progress", conclusion: null },
  ])("does not report a $name replacement as a dry-run revive", async ({ status, conclusion }) => {
    const generated = autoMergePr(42, "6".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, { status, conclusion }),
        ],
      },
      workflowRunsById: {
        100: cancelledRun(100),
        200: cancelledRun(200, { conclusion }),
      },
    });
    const { core: loggedCore, logs } = recordingCore();

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      dryRun: true,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
    expect(logs.some((line) => line.includes("would revive cancelled run 100"))).toBe(false);
  });

  it("does not revive a run superseded during pre-mutation revalidation", async () => {
    const generated = autoMergePr(43, "7".repeat(40));
    const cancelled = githubActionsCheck(100);
    const replacement = githubActionsCheck(200, { conclusion: "success" });
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [[cancelled], [cancelled, replacement]],
      },
      workflowRunsById: {
        100: cancelledRun(100),
        200: cancelledRun(200, { conclusion: "success" }),
      },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "checks.listForRef")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it.each([
    { name: "cancelled run", cancelledWorkflowId: null, replacementWorkflowId: 10 },
    { name: "replacement run", cancelledWorkflowId: 10, replacementWorkflowId: null },
  ])(
    "does not revive when the $name has no verifiable workflow identity",
    async ({ cancelledWorkflowId, replacementWorkflowId }) => {
      const generated = autoMergePr(44, "8".repeat(40));
      const { github, calls } = fakeGithub({
        prs: [generated],
        runsBySha: {},
        checksByRef: {
          [generated.head.sha]: [
            githubActionsCheck(100),
            githubActionsCheck(200, { conclusion: "success" }),
          ],
        },
        workflowRunsById: {
          100: cancelledRun(100, { workflow_id: cancelledWorkflowId }),
          200: cancelledRun(200, {
            workflow_id: replacementWorkflowId,
            conclusion: "success",
          }),
        },
      });

      await runPrCiSweeper({
        github: github as never,
        context: context as never,
        core: core as never,
        now: NOW,
      });

      expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
    },
  );

  it.each([
    { name: "missing", detailsUrl: null },
    { name: "undefined", detailsUrl: undefined },
    { name: "malformed", detailsUrl: "https://github.com/openclaw/openclaw/actions/runs/nope" },
  ])("does not revive when an Actions replacement has a $name run URL", async ({ detailsUrl }) => {
    const generated = autoMergePr(46, "a".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, { conclusion: "success", details_url: detailsUrl }),
        ],
      },
      workflowRunsById: { 100: cancelledRun(100) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("does not let a malformed non-Actions check suppress a cancelled workflow", async () => {
    const generated = autoMergePr(47, "b".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, {
            app: { slug: "external-ci" },
            conclusion: "success",
            details_url: null,
          }),
        ],
      },
      workflowRunsById: { 100: cancelledRun(100) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([
      {
        method: "actions.reRunWorkflow",
        args: { owner: "openclaw", repo: "openclaw", run_id: 100 },
      },
    ]);
  });

  it("fails closed when replacement workflow metadata cannot be loaded", async () => {
    const generated = autoMergePr(45, "9".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, { conclusion: "success" }),
        ],
      },
      workflowRunsById: { 100: cancelledRun(100) },
      workflowRunErrorsById: { 200: new Error("replacement workflow unavailable") },
    });

    await expect(
      runPrCiSweeper({
        github: github as never,
        context: context as never,
        core: core as never,
        now: NOW,
      }),
    ).rejects.toThrow("replacement workflow unavailable");

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("does not revive a run triggered from a different branch on a shared commit", async () => {
    const generated = autoMergePr(14, "f".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(4321)] },
      workflowRunsById: { 4321: cancelledRun(4321, { head_branch: "some/foreign-branch" }) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("defers revive while the head has active checks", async () => {
    const generated = autoMergePr(15, "9".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(7777),
          githubActionsCheck(8888, { status: "in_progress", conclusion: null }),
        ],
      },
      workflowRunsById: { 7777: cancelledRun(7777) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("skips cancelled checks from non-GitHub-Actions apps", async () => {
    const generated = autoMergePr(11, "e".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [githubActionsCheck(2345, { app: { slug: "external-ci" } })],
      },
      workflowRunsById: { 2345: cancelledRun(2345) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.getWorkflowRun")).toEqual([]);
    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("skips a workflow run that predates the PR", async () => {
    const generated = autoMergePr(12, "f".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(3456)] },
      workflowRunsById: {
        3456: cancelledRun(3456, {
          created_at: new Date(Date.parse(generated.created_at) - MINUTES).toISOString(),
        }),
      },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("skips a workflow run at the revive attempt limit", async () => {
    const generated = autoMergePr(13, "1".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(4567)] },
      workflowRunsById: { 4567: cancelledRun(4567, { run_attempt: 3 }) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("logs a dry-run revive without rerunning or closing", async () => {
    const generated = autoMergePr(14, "2".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(5678)] },
      workflowRunsById: { 5678: cancelledRun(5678, { run_attempt: 2 }) },
    });
    const { core: loggedCore, logs } = recordingCore();

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      dryRun: true,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
    expect(logs).toContain("pr-ci-sweeper: dry-run, would revive cancelled run 5678 for #14");
  });

  it("does not rerun when the PR head changes during revalidation", async () => {
    const generated = autoMergePr(15, "3".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(6789)] },
      workflowRunsById: { 6789: cancelledRun(6789) },
      pullsGetByNumber: {
        [generated.number]: { ...generated, head: { sha: "4".repeat(40) } },
      },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });
});
