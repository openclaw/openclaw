import { describe, expect, it, vi } from "vitest";
import { runPrCiSweeper } from "../../scripts/github/pr-ci-sweeper.mjs";
import { NOW, context, fakeGithub, pr, recordingCore } from "./pr-ci-sweeper.test-support.js";

describe("runPrCiSweeper", () => {
  it("recovers a transient CI read and continues scanning without re-firing attached runs", async () => {
    const attached = [21, 22].map((number) =>
      Object.assign(pr(), {
        number,
        state: "open",
        head: { sha: String(number).repeat(20) },
      }),
    );
    const { github, calls } = fakeGithub({
      prs: attached,
      runsBySha: Object.fromEntries(
        attached.map((candidate) => [candidate.head.sha, [{ conclusion: "success" }]]),
      ),
    });
    const paginate = github.paginate;
    let ciReads = 0;
    vi.spyOn(github, "paginate").mockImplementation((endpoint, args, mapFn) => {
      if (endpoint === github.rest.actions.listWorkflowRuns && ++ciReads === 1) {
        return Promise.reject(Object.assign(new Error("other side closed"), { status: 500 }));
      }
      return paginate(endpoint, args, mapFn);
    });
    const { core } = recordingCore();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = expect(runPrCiSweeper({ github, context, core, now: NOW })).resolves.toEqual(
        attached.map((candidate) => ({
          number: candidate.number,
          sha: candidate.head.sha.slice(0, 12),
          action: "skip",
          reason: "ci-attached",
        })),
      );
      await vi.runAllTimersAsync();
      await result;
      expect(ciReads).toBe(3);
      expect(calls.some((call) => call.method === "pulls.update")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { status: 500, attempts: 3 },
    { status: 403, attempts: 1 },
  ])(
    "surfaces HTTP $status after $attempts reads without mutating",
    async ({ status, attempts }) => {
      const candidate = { ...pr(), number: 23, state: "open", head: { sha: "a".repeat(40) } };
      const { github, calls } = fakeGithub({ prs: [candidate], runsBySha: {} });
      const paginate = github.paginate;
      const error = Object.assign(new Error("CI lookup failed"), { status });
      let ciReads = 0;
      vi.spyOn(github, "paginate").mockImplementation((endpoint, args, mapFn) => {
        if (endpoint === github.rest.actions.listWorkflowRuns) {
          ciReads += 1;
          return Promise.reject(error);
        }
        return paginate(endpoint, args, mapFn);
      });
      const { core } = recordingCore();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = expect(runPrCiSweeper({ github, context, core, now: NOW })).rejects.toBe(
          error,
        );
        await vi.runAllTimersAsync();
        await result;
        expect(ciReads).toBe(attempts);
        expect(calls.some((call) => call.method === "pulls.update")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { name: "missing CI", ciRuns: [], reason: "ci-run-missing" },
    {
      name: "startup-failed CI",
      ciRuns: [{ conclusion: "startup_failure" }],
      reason: "ci-startup-failure",
    },
  ])("recovers $name without spending budget on stale heads", async ({ ciRuns, reason }) => {
    const dropped = Array.from({ length: 11 }, (_, index) => ({
      ...pr(),
      number: 200 + index,
      state: "open",
      head: { sha: index.toString(16).padStart(2, "0").repeat(20) },
    }));
    const pullsGetByNumber = Object.fromEntries(
      dropped
        .slice(0, 10)
        .map((candidate) => [
          candidate.number,
          [candidate, { ...candidate, head: { sha: "f".repeat(40) } }],
        ]),
    );
    const { github, calls } = fakeGithub({
      prs: dropped,
      runsBySha: Object.fromEntries(dropped.map((candidate) => [candidate.head.sha, ciRuns])),
      pullsGetByNumber,
    });
    const { core: loggedCore, logs, warnings } = recordingCore();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const operation = runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      appSlug: "openclaw-barnacle",
      now: NOW,
    });
    void operation.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.at(-1)).toEqual({
        method: "pulls.update",
        args: { owner: "openclaw", repo: "openclaw", pull_number: 210, state: "closed" },
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(
        calls.filter((call) => call.method === "pulls.update").map((call) => call.args.state),
      ).toEqual(["closed"]);
      await vi.advanceTimersByTimeAsync(1);
      const results = await operation;

      expect(results).toHaveLength(dropped.length);
      expect(results.slice(0, 10)).toEqual(
        dropped.slice(0, 10).map((candidate) => ({
          number: candidate.number,
          sha: candidate.head.sha.slice(0, 12),
          action: "skip",
          reason: "changed-during-sweep",
        })),
      );
      expect(results.at(-1)).toEqual({
        number: 210,
        sha: "0a".repeat(6),
        action: "refire",
        reason,
      });
      expect(
        calls.filter((call) => call.method === "pulls.update").map((call) => call.args),
      ).toEqual([
        { owner: "openclaw", repo: "openclaw", pull_number: 210, state: "closed" },
        { owner: "openclaw", repo: "openclaw", pull_number: 210, state: "open" },
      ]);
      expect(logs.at(-1)).toContain("1 re-fire");
      expect(warnings).toEqual([
        `pr-ci-sweeper: re-firing CI for #210 (${reason}; GitHub startup recovery)`,
      ]);
      expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
