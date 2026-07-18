import { describe, expect, it } from "vitest";
import { classifyPrForSweep } from "../../scripts/github/pr-ci-sweeper.mjs";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;

function pr(overrides: Partial<Parameters<typeof classifyPrForSweep>[0]["pr"]> = {}) {
  return {
    draft: false,
    created_at: new Date(NOW - 2 * HOURS).toISOString(),
    updated_at: new Date(NOW - 30 * MINUTES).toISOString(),
    mergeable: true,
    auto_merge: null,
    ...overrides,
  };
}

describe("classifyPrForSweep", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof classifyPrForSweep>[0];
    expected: ReturnType<typeof classifyPrForSweep>;
  }> = [
    {
      name: "re-fires when no CI run attached",
      input: { pr: pr(), ciRuns: [], botCloseCount: 0, now: NOW },
      expected: { action: "refire", reason: "ci-run-missing" },
    },
    {
      name: "re-fires when only startup failures attached",
      input: {
        pr: pr(),
        ciRuns: [{ conclusion: "startup_failure" }],
        botCloseCount: 1,
        now: NOW,
      },
      expected: { action: "refire", reason: "ci-startup-failure" },
    },
    {
      name: "skips drafts",
      input: { pr: pr({ draft: true }), ciRuns: [], botCloseCount: 0, now: NOW },
      expected: { action: "skip", reason: "draft" },
    },
    {
      name: "skips PRs outside the 24h lookback",
      input: {
        pr: pr({ created_at: new Date(NOW - 25 * HOURS).toISOString() }),
        ciRuns: [],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "outside-lookback" },
    },
    {
      name: "skips recently updated PRs so merge-ref computation can settle",
      input: {
        pr: pr({ updated_at: new Date(NOW - 5 * MINUTES).toISOString() }),
        ciRuns: [],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "recently-updated" },
    },
    {
      name: "skips merge conflicts whose merge ref legitimately cannot exist",
      input: { pr: pr({ mergeable: false }), ciRuns: [], botCloseCount: 0, now: NOW },
      expected: { action: "skip", reason: "merge-conflict" },
    },
    {
      name: "skips PRs with auto-merge enabled (close would cancel it)",
      input: {
        pr: pr({ auto_merge: { merge_method: "squash" } }),
        ciRuns: [],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "auto-merge-enabled" },
    },
    {
      name: "treats a completed run as attached",
      input: {
        pr: pr(),
        ciRuns: [{ conclusion: "success" }],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "treats a queued run (null conclusion) as attached",
      input: {
        pr: pr(),
        ciRuns: [{ conclusion: null }, { conclusion: "startup_failure" }],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "treats a failed run as attached (rerunnable, not sweepable)",
      input: {
        pr: pr(),
        ciRuns: [{ conclusion: "failure" }],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "stops after two bot closes",
      input: { pr: pr(), ciRuns: [], botCloseCount: 2, now: NOW },
      expected: { action: "skip", reason: "refire-budget-exhausted" },
    },
    {
      name: "skips while mergeability is still computing",
      input: { pr: pr({ mergeable: null }), ciRuns: [], botCloseCount: 0, now: NOW },
      expected: { action: "skip", reason: "mergeability-pending" },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(classifyPrForSweep(input)).toEqual(expected);
  });
});
