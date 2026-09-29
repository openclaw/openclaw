import { describe, expect, it } from "vitest";
import { classifyPrForSweep, runPrCiSweeper } from "../../scripts/github/pr-ci-sweeper.mjs";
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
    "logs attached %s CI on a non-auto-merge PR without re-executing it",
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

  it.each(["pull_request", "pull_request_target"])(
    "leaves a cancelled %s workflow attached to an auto-merge PR without re-executing it",
    async (event) => {
      const generated = autoMergePr(10, "d".repeat(40));
      const { github, calls } = fakeGithub({
        prs: [generated],
        runsBySha: {
          [generated.head.sha]: [{ id: 1234, status: "completed", conclusion: "cancelled" }],
        },
        checksByRef: { [generated.head.sha]: [githubActionsCheck(1234)] },
        workflowRunsById: { 1234: cancelledRun(1234, { event }) },
      });

      const results = await runPrCiSweeper({ github, context, core, now: NOW });

      expect(results).toEqual([
        { number: 10, sha: "d".repeat(12), action: "skip", reason: "auto-merge-enabled" },
      ]);
      expect(
        calls.filter((call) =>
          ["actions.reRunWorkflow", "pulls.update", "issues.createComment"].includes(call.method),
        ),
      ).toEqual([]);
    },
  );
});
