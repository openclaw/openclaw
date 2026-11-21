import { describe, expect, it } from "vitest";
import { runStep } from "./update-runner-command.js";

describe("update command failure diagnostics", () => {
  it.each(["stderr", "stdout"] as const)(
    "keeps the sanitized child cause below a package-manager banner in %s",
    async (stream) => {
      const diagnostic = `\u001b[31mError: Candidate build refused; token=fixture-private-token ${"detail ".repeat(50)}\u001b[0m`;
      const result = await runStep({
        name: "preflight-build",
        argv: ["pnpm", "build"],
        cwd: "/fixture",
        timeoutMs: 1000,
        stepIndex: 0,
        totalSteps: 1,
        runCommand: async () => ({
          code: 17,
          stdout: stream === "stdout" ? diagnostic : "",
          stderr:
            stream === "stderr"
              ? `$ node scripts/build-all.mts\n${diagnostic}\n`
              : "$ node scripts/build-all.mts\n",
        }),
      });
      expect(result.exitCode).toBe(17);
      expect(result.failureFacts?.[0]?.message).toContain("Candidate build refused");
      expect(result.failureFacts?.[0]?.message).not.toContain("fixture-private-token");
      expect(result.failureFacts?.[0]?.message).not.toContain("\u001b");
      expect(result.failureFacts?.[0]?.message?.length).toBeLessThanOrEqual(200);
    },
  );
  it.each([
    {
      name: "non-banner",
      stderr: "Compiler rejected candidate\nError: secondary context",
      stdout: "Error: later output",
      expected: "Compiler rejected candidate",
    },
    {
      name: "banner without an error header",
      stderr: "$ node scripts/build-all.mts\ncompiler status: failed",
      stdout: "",
      expected: "$ node scripts/build-all.mts",
    },
  ])("preserves the $name diagnostic fallback", async ({ stderr, stdout, expected }) => {
    const result = await runStep({
      name: "preflight-build",
      argv: ["pnpm", "build"],
      cwd: "/fixture",
      timeoutMs: 1000,
      stepIndex: 0,
      totalSteps: 1,
      runCommand: async () => ({ code: 17, stderr, stdout }),
    });
    expect(result.failureFacts?.[0]?.message).toBe(expected);
  });
});
