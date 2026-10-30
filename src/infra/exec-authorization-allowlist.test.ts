import { describe, expect, it } from "vitest";
import {
  makeExecutable,
  makePathEnv,
  makeExecApprovalsTempDir,
} from "./exec-approvals-test-helpers.js";
import {
  evaluateShellAllowlistWithAuthorization,
  requiresExecApproval,
  resolveAllowAlwaysPersistenceDecision,
} from "./exec-approvals.js";

function evaluate(
  command: string,
  options: Partial<Parameters<typeof evaluateShellAllowlistWithAuthorization>[0]> = {},
) {
  return evaluateShellAllowlistWithAuthorization({
    command,
    allowlist: [],
    safeBins: new Set(),
    platform: process.platform,
    ...options,
  });
}

describe("authorization-backed exec allowlist", () => {
  it.each([
    { command: `echo "$HOME"; python3 -c 'print(1)'`, analysisOk: false, first: ["echo", "$HOME"] },
    { command: `sh -c 'echo ok; python3 -c "print(1)"'`, analysisOk: true, first: ["echo", "ok"] },
  ])("keeps inline-eval segments visible for $command", async ({ command, analysisOk, first }) => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluate(command);
    expect(result).toMatchObject({ analysisOk, allowlistSatisfied: false });
    expect(result.segments.map((segment) => segment.argv)).toEqual([
      first,
      ["python3", "-c", "print(1)"],
    ]);
  });

  it("keeps glued allowlisted inline-eval commands one-shot in strict mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeExecApprovalsTempDir();
    const pythonPath = makeExecutable(dir, "python3");
    const env = makePathEnv(dir);
    const command = "python3 -xcprint";
    const result = await evaluate(command, {
      allowlist: [{ pattern: pythonPath }],
      cwd: dir,
      env,
    });
    expect(result).toMatchObject({ analysisOk: true, allowlistSatisfied: true });
    expect(result.segments.map((segment) => segment.argv)).toEqual([["python3", "-xcprint"]]);
    expect(
      resolveAllowAlwaysPersistenceDecision({
        segments: result.segments,
        authorizationPlan: result.authorizationPlan,
        commandText: command,
        platform: process.platform,
        cwd: dir,
        env,
        strictInlineEval: true,
      }),
    ).toEqual({ kind: "one-shot", reasons: expect.arrayContaining(["no-reusable-pattern"]) });
  });

  it.each([
    ["./sh -c 'git status'", ["git"], null, [["./sh", "-c", "git status"]]],
    [
      "sleep 10 & echo done",
      ["sleep", "echo"],
      "background",
      [
        ["sleep", "10"],
        ["echo", "done"],
      ],
    ],
    ["echo safe \\\nunsafe", ["echo"], "line-continuation", null],
    ["tr x\n\\id", ["tr"], "line-continuation", null],
  ] as const)(
    "requires approval for unsafe shell syntax: %s",
    async (command, bins, reason, argv) => {
      if (process.platform === "win32") {
        return;
      }
      const result = await evaluate(command, { safeBins: new Set(bins) });
      expect(result).toMatchObject({ analysisOk: reason === null, allowlistSatisfied: false });
      if (reason) {
        expect(result.authorizationPlan).toMatchObject({ ok: false, reason });
      } else {
        expect(result.segmentSatisfiedBy).toEqual([null]);
      }
      if (argv) {
        expect(result.segments.map((segment) => segment.argv)).toEqual(argv);
      }
      expect(requiresExecApproval({ ask: "on-miss", security: "allowlist", ...result })).toBe(true);
    },
  );
});
