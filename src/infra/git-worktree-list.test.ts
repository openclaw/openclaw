import { describe, expect, it, vi } from "vitest";
import { readCompatibleGitWorktreeList } from "./git-worktree-list.js";

type Result = {
  termination: "exit" | "signal";
  code: number | null;
  stdout: string;
  stderr: string;
};

function result(overrides: Partial<Result> = {}): Result {
  return { termination: "exit", code: 0, stdout: "", stderr: "", ...overrides };
}

function requireOutput(command: string, outcome: Result): string {
  if (outcome.termination !== "exit" || outcome.code !== 0) {
    throw new Error(`${command} failed (${outcome.termination}, exit ${outcome.code})`);
  }
  return outcome.stdout;
}

describe("readCompatibleGitWorktreeList", () => {
  it("falls back after exit 129 without inspecting stderr", async () => {
    const run = vi
      .fn<(args: string[]) => Promise<Result>>()
      .mockResolvedValueOnce(result({ code: 129, stderr: "unbekannte Option" }))
      .mockResolvedValueOnce(
        result({
          stdout:
            'worktree /tmp/résumé path\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/main\nlocked "held\\n\\t\\"caf\\303\\251"\n\n',
        }),
      );

    await expect(readCompatibleGitWorktreeList(run, requireOutput)).resolves.toBe(
      'worktree /tmp/résumé path\0HEAD 0123456789012345678901234567890123456789\0branch refs/heads/main\0locked held\n\t"café\0\0',
    );
    expect(run).toHaveBeenNthCalledWith(1, ["worktree", "list", "--porcelain", "-z"]);
    expect(run).toHaveBeenNthCalledWith(2, ["worktree", "list", "--porcelain"]);
  });

  it.each([
    "worktree /tmp/split\npath\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/main\n\n",
    "worktree /tmp/repo\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/main\nunknown value\n\n",
  ])("rejects ambiguous legacy output without disclosing it", async (stdout) => {
    const run = vi
      .fn<(args: string[]) => Promise<Result>>()
      .mockResolvedValueOnce(result({ code: 129 }))
      .mockResolvedValueOnce(result({ stdout }));

    const error = await readCompatibleGitWorktreeList(run, requireOutput).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ambiguous output");
    expect((error as Error).message).not.toContain("/tmp/");
  });

  it("does not retry failures other than a normal exit 129", async () => {
    const run = vi
      .fn<(args: string[]) => Promise<Result>>()
      .mockResolvedValue(result({ code: 128, stderr: "fatal" }));

    await expect(readCompatibleGitWorktreeList(run, requireOutput)).rejects.toThrow(
      "git worktree list failed (exit, exit 128)",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a failed fallback command", async () => {
    const run = vi
      .fn<(args: string[]) => Promise<Result>>()
      .mockResolvedValueOnce(result({ code: 129 }))
      .mockResolvedValueOnce(result({ code: 1 }));

    await expect(readCompatibleGitWorktreeList(run, requireOutput)).rejects.toThrow(
      "git worktree list --porcelain failed (exit, exit 1)",
    );
  });
});
