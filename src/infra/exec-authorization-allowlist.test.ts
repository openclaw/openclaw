import { describe, expect, it } from "vitest";
import { detectPolicyInlineEval } from "./command-analysis/policy.js";
import { makeExecutable, makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  evaluateShellAllowlistWithAuthorization,
  requiresExecApproval,
  resolveAllowAlwaysPersistenceDecision,
  resolveExecApprovalAllowedDecisions,
} from "./exec-approvals.js";

describe("authorization-backed exec allowlist", () => {
  it("keeps later inline-eval segments visible when durable planning fails", async () => {
    if (process.platform === "win32") {
      return;
    }

    const result = await evaluateShellAllowlistWithAuthorization({
      command: `echo "$HOME"; python3 -c 'print(1)'`,
      allowlist: [],
      safeBins: new Set(),
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(false);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segments.map((segment) => segment.argv)).toEqual([
      ["echo", "$HOME"],
      ["python3", "-c", "print(1)"],
    ]);
    expect(detectPolicyInlineEval(result.segments)).toEqual(
      expect.objectContaining({
        executable: "python3",
        flag: "-c",
      }),
    );
  });

  it("keeps risky shell-wrapper payload segments visible when persistence is blocked", async () => {
    if (process.platform === "win32") {
      return;
    }

    const result = await evaluateShellAllowlistWithAuthorization({
      command: `sh -c 'echo ok; python3 -c "print(1)"'`,
      allowlist: [],
      safeBins: new Set(),
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segments.map((segment) => segment.argv)).toEqual([
      ["echo", "ok"],
      ["python3", "-c", "print(1)"],
    ]);
    expect(detectPolicyInlineEval(result.segments)).toEqual(
      expect.objectContaining({
        executable: "python3",
        flag: "-c",
      }),
    );
  });

  it("allows allowlisted inline-eval commands while keeping allow-always one-shot", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = makeTempDir();
    const pythonPath = makeExecutable(dir, "python3");
    const env = makePathEnv(dir);
    const command = "python3 -c 'print(1)'";

    const result = await evaluateShellAllowlistWithAuthorization({
      command,
      allowlist: [{ pattern: pythonPath }],
      safeBins: new Set(),
      cwd: dir,
      env,
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.segments.map((segment) => segment.argv)).toEqual([["python3", "-c", "print(1)"]]);
    expect(result.segmentSatisfiedBy).toEqual(["allowlist"]);
    expect(detectPolicyInlineEval(result.segments)).toEqual(
      expect.objectContaining({
        executable: "python3",
        flag: "-c",
      }),
    );

    const allowAlwaysPersistence = resolveAllowAlwaysPersistenceDecision({
      segments: result.segments,
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: result.authorizationPlan,
    });

    expect(allowAlwaysPersistence).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it("does not satisfy path-scoped shell wrappers from trusted inner payloads", async () => {
    if (process.platform === "win32") {
      return;
    }

    const result = await evaluateShellAllowlistWithAuthorization({
      command: `./sh -c 'git status'`,
      allowlist: [],
      safeBins: new Set(["git"]),
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segments.map((segment) => segment.argv)).toEqual([["./sh", "-c", "git status"]]);
    expect(result.segmentSatisfiedBy).toEqual([null]);
  });

  it("keeps background jobs visible but not allowlist-satisfied", async () => {
    if (process.platform === "win32") {
      return;
    }

    const result = await evaluateShellAllowlistWithAuthorization({
      command: "sleep 10 & echo done",
      allowlist: [],
      safeBins: new Set(["sleep", "echo"]),
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(false);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segments.map((segment) => segment.argv)).toEqual([
      ["sleep", "10"],
      ["echo", "done"],
    ]);
    expect(result.authorizationPlan).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "background",
      }),
    );
  });

  it("keeps line-continuation shell commands out of allow-always approval", async () => {
    if (process.platform === "win32") {
      return;
    }

    const command = "echo safe \\\nunsafe";
    const result = await evaluateShellAllowlistWithAuthorization({
      command,
      allowlist: [],
      safeBins: new Set(["echo"]),
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(false);
    expect(result.authorizationPlan).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "line-continuation",
      }),
    );

    const allowAlwaysPersistence = resolveAllowAlwaysPersistenceDecision({
      segments: result.segments,
      commandText: command,
      platform: process.platform,
      authorizationPlan: result.authorizationPlan,
    });

    expect(allowAlwaysPersistence).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["unplanned"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it("does not require approval for an allowlisted command with a harmless redirect", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = makeTempDir();
    const headPath = makeExecutable(dir, "head");
    const env = makePathEnv(dir);

    const result = await evaluateShellAllowlistWithAuthorization({
      command: "head -n 1 2>/dev/null",
      allowlist: [{ pattern: headPath }],
      safeBins: new Set(),
      cwd: dir,
      env,
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
    // The redirect leaves argv untouched, so allowlist matching still applies.
    expect(result.segments.map((segment) => segment.argv)).toEqual([["head", "-n", "1"]]);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: result.analysisOk,
        allowlistSatisfied: result.allowlistSatisfied,
      }),
    ).toBe(false);
  });

  it("still requires approval when a harmless redirect rides a chained unsafe command", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = makeTempDir();
    const headPath = makeExecutable(dir, "head");
    const env = makePathEnv(dir);

    // `head` is allowlisted and the redirect is harmless, but the chained `rm`
    // is not allowlisted: the command must still fall to the approval flow.
    const result = await evaluateShellAllowlistWithAuthorization({
      command: "head -n 1 2>/dev/null; rm -rf /tmp/x",
      allowlist: [{ pattern: headPath }],
      safeBins: new Set(),
      cwd: dir,
      env,
      platform: process.platform,
    });

    // analysisOk proves the harmless redirect did NOT block planning (otherwise
    // this would be false); both segments parse, and the block is attributable to
    // the unallowlisted `rm`, not to the redirect.
    expect(result.analysisOk).toBe(true);
    expect(result.segments.map((segment) => segment.argv)).toEqual([
      ["head", "-n", "1"],
      ["rm", "-rf", "/tmp/x"],
    ]);
    expect(result.allowlistSatisfied).toBe(false);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: result.analysisOk,
        allowlistSatisfied: result.allowlistSatisfied,
      }),
    ).toBe(true);
  });
});
