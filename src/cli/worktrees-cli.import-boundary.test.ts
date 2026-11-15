import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("../agents/worktrees/service.js", () => {
  throw new Error("Worktree service is unavailable");
});

vi.mock("../agents/worktrees/owner-protection.js", () => {
  throw new Error("Worktree cleanup owner checks are unavailable");
});

describe("worktrees command registration", () => {
  it("renders help without loading worktree operations or cleanup owners", async () => {
    const { registerWorktreesCli } = await import("./worktrees-cli.js");
    for (const leaf of [undefined, "list", "create", "remove", "restore", "gc"]) {
      const output: string[] = [];
      const program = new Command().exitOverride();
      program.configureOutput({ writeOut: (text) => output.push(text) });
      registerWorktreesCli(program);
      const commandPath = leaf ? ["worktrees", leaf] : ["worktrees"];

      await expect(
        program.parseAsync([...commandPath, "--help"], { from: "user" }),
      ).rejects.toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
      expect(output.join("")).toContain(commandPath.join(" "));
    }
  });
});
