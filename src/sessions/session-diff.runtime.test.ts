import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runGit, runGitBuffered } from "../agents/worktrees/git.js";
import { createDeferredCore } from "../shared/deferred.js";
import { collectCheckoutDiffBaseline } from "./session-diff.runtime.js";

vi.mock("../agents/worktrees/git.js", () => ({
  runGit: vi.fn(),
  runGitBuffered: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.resetAllMocks());

describe("baseline inventory command settlement", () => {
  it.each(["tracked", "untracked"] as const)(
    "joins the other inventory before returning a %s command failure",
    async (failed) => {
      const root = tempDirs.make("openclaw-baseline-inventory-");
      vi.mocked(runGit).mockResolvedValue({
        stdout: `sha1\n${root}\n`,
        stderr: "",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
        timeoutMs: 30_000,
      });
      const gates = { tracked: createDeferredCore(), untracked: createDeferredCore() };
      const entered = new Set<string>();
      const failure = new Error(`${failed} inventory failed`);
      vi.mocked(runGitBuffered).mockImplementation(async (_cwd, args) => {
        const kind = args.includes("diff") ? "tracked" : "untracked";
        entered.add(kind);
        await gates[kind].promise;
        if (kind === failed) {
          throw failure;
        }
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: 30_000,
        };
      });
      let settled = false;
      const capture = collectCheckoutDiffBaseline({ cwd: root });
      const observed = capture.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await vi.waitFor(() => expect(entered).toEqual(new Set(["tracked", "untracked"])));
        gates[failed].resolve();
        await nextTurn();
        expect(settled).toBe(false);
        gates[failed === "tracked" ? "untracked" : "tracked"].resolve();
        await expect(capture).rejects.toBe(failure);
      } finally {
        gates.tracked.resolve();
        gates.untracked.resolve();
        await observed;
      }
    },
  );
});
