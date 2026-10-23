import { describe, expect, it } from "vitest";
import { classifyPrForSweep, runPrCiSweeper } from "../../scripts/github/pr-ci-sweeper.mjs";
import {
  HOURS,
  MINUTES,
  NOW,
  context,
  fakeGithub,
  pr,
  recordingCore,
} from "./pr-ci-sweeper.test-support.js";

function listedPr(number: number, sha: string, overrides: Parameters<typeof pr>[0] = {}) {
  return { ...pr(overrides), number, state: "open", head: { sha } };
}

async function sweep(
  fixture: Parameters<typeof fakeGithub>[0],
  options: Partial<Parameters<typeof runPrCiSweeper>[0]> = {},
) {
  const { github, calls } = fakeGithub(fixture);
  const { core, logs } = recordingCore();
  const results = await runPrCiSweeper({ github, context, core, now: NOW, ...options });
  return { calls, logs, results };
}

const decision = (number: number, sha: string, action: string, reason: string) => ({
  number,
  sha: sha.slice(0, 12),
  action,
  reason,
});
function expectNoMutation(calls: ReturnType<typeof fakeGithub>["calls"]) {
  expect(
    calls.filter((call) =>
      ["pulls.update", "actions.reRunWorkflow", "issues.createComment"].includes(call.method),
    ),
  ).toEqual([]);
}

describe("classifyPrForSweep", () => {
  type Pr = Parameters<typeof classifyPrForSweep>[0]["pr"];
  const cases: [string, Partial<Pr>, number][] = [
    ["draft", { draft: true }, 0],
    ["recently-updated", { updated_at: new Date(NOW - 5 * MINUTES).toISOString() }, 0],
    ["merge-conflict", { mergeable: false }, 0],
    ["refire-budget-exhausted", {}, 2],
  ];
  it.each(cases)("skips %s", (reason, overrides, botCloseCount) => {
    expect(classifyPrForSweep({ pr: pr(overrides), ciRuns: [], botCloseCount, now: NOW })).toEqual({
      action: "skip",
      reason,
    });
  });
});

describe("runPrCiSweeper", () => {
  it("classifies a dropped-CI PR as refire in dry-run without mutating", async () => {
    const dropped = listedPr(7, "a".repeat(40));
    const attached = listedPr(8, "b".repeat(40));
    const { results, calls } = await sweep(
      {
        prs: [dropped, attached],
        runsBySha: {
          [dropped.head.sha]: [{ conclusion: "startup_failure" }],
          [attached.head.sha]: [{ conclusion: "success" }],
        },
      },
      { dryRun: true, appSlug: "openclaw-barnacle" },
    );
    expect(results).toEqual([
      decision(7, dropped.head.sha, "refire", "ci-startup-failure"),
      decision(8, attached.head.sha, "skip", "ci-attached"),
    ]);
    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
  });

  it("logs cancelled CI without re-executing a non-auto-merge PR", async () => {
    const attached = listedPr(21, "5".repeat(40));
    const { results, calls, logs } = await sweep({
      prs: [attached],
      runsBySha: {
        [attached.head.sha]: [{ id: 100, status: "completed", conclusion: "cancelled" }],
      },
    });
    expect(results).toEqual([decision(21, attached.head.sha, "skip", "ci-attached")]);
    expect(logs).toContain("pr-ci-sweeper: skip #21 (ci-attached: 100:completed/cancelled)");
    expectNoMutation(calls);
  });

  it("logs draft skips so every scanned PR has a decision", async () => {
    const draft = listedPr(22, "6".repeat(40), { draft: true });
    const { results, calls, logs } = await sweep({ prs: [draft], runsBySha: {} });
    expect(results).toEqual([decision(22, draft.head.sha, "skip", "draft")]);
    expect(logs).toContain("pr-ci-sweeper: skip #22 (draft)");
    // Drafts skip before the per-head run lookup so they cost no Actions reads.
    expect(calls.filter((call) => call.method === "actions.listWorkflowRuns")).toEqual([]);
  });

  it("does not re-fire startup-failed CI when the final PR read becomes draft", async () => {
    const candidate = listedPr(23, "7".repeat(40));
    const { results, calls, logs } = await sweep({
      prs: [candidate],
      runsBySha: { [candidate.head.sha]: [{ conclusion: "startup_failure" }] },
      pullsGetByNumber: {
        [candidate.number]: [candidate, { ...candidate, draft: true }],
      },
    });
    expectNoMutation(calls);
    expect(results).toEqual([decision(23, candidate.head.sha, "skip", "changed-during-sweep")]);
    expect(logs).toContain("pr-ci-sweeper: #23 changed during sweep; leaving it alone");
    expect(logs.at(-1)).toContain("0 re-fires");
    expect(
      calls
        .filter((call) => call.method === "pulls.get" || call.method === "actions.listWorkflowRuns")
        .map((call) => call.method),
    ).toEqual(["actions.listWorkflowRuns", "pulls.get", "pulls.get"]);
  });

  it("keeps logging decisions after the per-sweep re-fire cap", async () => {
    const dropped = Array.from({ length: 11 }, (_, index) =>
      listedPr(100 + index, index.toString(16).padStart(2, "0").repeat(20)),
    );
    const { results, calls, logs } = await sweep({ prs: dropped, runsBySha: {} }, { dryRun: true });
    expect(results.filter((entry) => entry.action === "refire")).toHaveLength(10);
    expect(results.at(-1)).toEqual(decision(110, "0a".repeat(20), "skip", "refire-cap-reached"));
    expect(logs).toContain("pr-ci-sweeper: skip #110 (refire-cap-reached)");
    // The capped PR is classified from list data only, never fetched.
    expect(
      calls.filter((call) => call.method === "pulls.get" && call.args.pull_number === 110),
    ).toEqual([]);
  });

  it("stops listing pages once creation dates cross the lookback", async () => {
    const recent = listedPr(30, "7".repeat(40));
    const oldA = listedPr(31, "8".repeat(40), {
      created_at: new Date(NOW - 25 * HOURS).toISOString(),
    });
    const oldB = listedPr(32, "9".repeat(40), {
      created_at: new Date(NOW - 30 * HOURS).toISOString(),
    });
    const { results, calls } = await sweep(
      {
        prs: [recent, oldA, oldB],
        runsBySha: {},
        pageSize: 1,
      },
      { dryRun: true },
    );
    // Page 2 crossed the 24h creation horizon, so page 3 is never fetched and
    // the outside-lookback PR on page 2 stops the scan without a decision.
    expect(calls.filter((call) => call.method === "pulls.list.page")).toHaveLength(2);
    expect(results).toEqual([decision(30, recent.head.sha, "refire", "ci-run-missing")]);
  });

  it("leaves cancelled CI attached to an auto-merge PR without re-executing it", async () => {
    const generated = listedPr(10, "d".repeat(40), { auto_merge: { merge_method: "squash" } });
    const { results, calls } = await sweep({
      prs: [generated],
      runsBySha: {
        [generated.head.sha]: [{ id: 1234, status: "completed", conclusion: "cancelled" }],
      },
    });

    expect(results).toEqual([decision(10, generated.head.sha, "skip", "auto-merge-enabled")]);
    expectNoMutation(calls);
  });
});
