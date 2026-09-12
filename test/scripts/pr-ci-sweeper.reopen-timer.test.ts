import { describe, expect, it, vi } from "vitest";
import { runPrCiSweeper } from "../../scripts/github/pr-ci-sweeper.mjs";
import { NOW, context, fakeGithub, pr, recordingCore } from "./pr-ci-sweeper.test-support.js";

describe("runPrCiSweeper", () => {
  it("closes and reopens a dropped-CI PR without spending budget on stale heads", async () => {
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
    const { github, calls } = fakeGithub({ prs: dropped, runsBySha: {}, pullsGetByNumber });
    const { core: loggedCore, logs } = recordingCore();

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
        reason: "ci-run-missing",
      });
      expect(
        calls.filter((call) => call.method === "pulls.update").map((call) => call.args),
      ).toEqual([
        { owner: "openclaw", repo: "openclaw", pull_number: 210, state: "closed" },
        { owner: "openclaw", repo: "openclaw", pull_number: 210, state: "open" },
      ]);
      expect(logs.at(-1)).toContain("1 re-fire");
    } finally {
      vi.useRealTimers();
    }
  });
});
