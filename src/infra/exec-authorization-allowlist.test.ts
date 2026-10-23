import { describe, expect, it } from "vitest";
import { detectInlineEvalInSegments } from "./command-analysis/risks.js";
import {
  makeExecutable,
  makePathEnv,
  makeExecApprovalsTempDir,
} from "./exec-approvals-test-helpers.js";
import {
  evaluateShellAllowlistWithAuthorization,
  requiresExecApproval,
  resolveAllowAlwaysPersistenceDecision,
  resolveExecApprovalAllowedDecisions,
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

function expectInlineEval(segments: Parameters<typeof detectInlineEvalInSegments>[0]) {
  expect(detectInlineEvalInSegments(segments)).toEqual(
    expect.objectContaining({ executable: "python3", flag: "-c" }),
  );
}

function expectOneShot(
  result: Awaited<ReturnType<typeof evaluate>>,
  commandText: string,
  reason: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; strictInlineEval?: boolean } = {},
) {
  const allowAlwaysPersistence = resolveAllowAlwaysPersistenceDecision({
    segments: result.segments,
    commandText,
    platform: process.platform,
    authorizationPlan: result.authorizationPlan,
    ...options,
  });
  expect(allowAlwaysPersistence).toEqual({
    kind: "one-shot",
    reasons: expect.arrayContaining([reason]),
  });
  expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence })).toEqual([
    "allow-once",
    "deny",
  ]);
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
    expectInlineEval(result.segments);
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
    expectInlineEval(result.segments);

    expectOneShot(result, command, "no-reusable-pattern", {
      cwd: dir,
      env,
      strictInlineEval: true,
    });
  });

  it("does not satisfy path-scoped shell wrappers from trusted inner payloads", async () => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluate(`./sh -c 'git status'`, { safeBins: new Set(["git"]) });

    expect(result).toMatchObject({ analysisOk: true, allowlistSatisfied: false });
    expect(result.segments.map((segment) => segment.argv)).toEqual([["./sh", "-c", "git status"]]);
    expect(result.segmentSatisfiedBy).toEqual([null]);
  });

  it("keeps background jobs visible but not allowlist-satisfied", async () => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluate("sleep 10 & echo done", { safeBins: new Set(["sleep", "echo"]) });

    expect(result).toMatchObject({ analysisOk: false, allowlistSatisfied: false });
    expect(result.segments.map((segment) => segment.argv)).toEqual([
      ["sleep", "10"],
      ["echo", "done"],
    ]);
    expect(result.authorizationPlan).toEqual(
      expect.objectContaining({ ok: false, reason: "background" }),
    );
  });

  it("keeps line-continuation shell commands out of allow-always approval", async () => {
    if (process.platform === "win32") {
      return;
    }
    const command = "echo safe \\\nunsafe";
    const result = await evaluate(command, { safeBins: new Set(["echo"]) });

    expect(result.analysisOk).toBe(false);
    expect(result.authorizationPlan).toEqual(
      expect.objectContaining({ ok: false, reason: "line-continuation" }),
    );

    expectOneShot(result, command, "unplanned");
  });

  it("does not satisfy allowlist policy for escaped word-boundary newlines", async () => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluate("tr x\n\\id", { safeBins: new Set(["tr"]) });

    expect(result).toMatchObject({ analysisOk: false, allowlistSatisfied: false });
    expect(result.authorizationPlan).toEqual(
      expect.objectContaining({ ok: false, reason: "line-continuation" }),
    );
    expect(requiresExecApproval({ ask: "on-miss", security: "allowlist", ...result })).toBe(true);
  });
});
