// Tests shared allow-always persistence decisions for command authorization plans.
import { describe, expect, it } from "vitest";
import { resolveCommandResolutionFromArgv } from "./exec-approvals-analysis.js";
import { makeExecutable, makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  resolveAllowAlwaysPersistenceDecision,
  resolveExecApprovalAllowedDecisions,
} from "./exec-approvals.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";

function plannedSegments(plan: Awaited<ReturnType<typeof planShellAuthorization>>) {
  return plan.ok
    ? plan.groups.flatMap((group) => group.candidates.map((candidate) => candidate.sourceSegment))
    : [];
}

describe("resolveAllowAlwaysPersistenceDecision", () => {
  it("chooses reusable patterns for allow-always planner candidates", async () => {
    const dir = makeTempDir();
    const gitPath = makeExecutable(dir, "git");
    const env = makePathEnv(dir);
    const plan = await planShellAuthorization({ command: "git status", cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: "git status",
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "patterns",
      commandText: "git status",
      patterns: [expect.objectContaining({ pattern: gitPath })],
    });
  });

  it("keeps shell wrappers without reusable patterns one-shot", async () => {
    const cwd = makeTempDir();
    const command = "sh -c './scripts/run.sh'";
    const plan = await planShellAuthorization({ command, cwd });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it("keeps shell wrappers without approved cwd one-shot", async () => {
    const command = "sh -c './scripts/run.sh'";
    const plan = await planShellAuthorization({ command });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it.each(["bash --login -c 'echo ok'", "bash -i -c 'echo ok'"])(
    "keeps startup shell wrappers one-shot: %s",
    async (command) => {
      const plan = await planShellAuthorization({ command });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
      expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
        "allow-once",
        "deny",
      ]);
    },
  );

  it.each([
    { command: 'eval "$CMD"', reason: "prompt-only" },
    { command: 'sh -c "$SCRIPT"', reason: "runtime-payload" },
    { command: "sh -c '$1' ignored echo", reason: "runtime-payload" },
    { command: "sh -c '$0 \"$@\"' xargs echo SAFE", reason: "runtime-payload" },
  ] as const)("keeps $command allow-always approvals one-shot", async ({ command, reason }) => {
    const plan = await planShellAuthorization({ command });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining([reason]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it("keeps failed authorization plans one-shot even when fallback segments have patterns", async () => {
    const dir = makeTempDir();
    const env = makePathEnv(dir);
    makeExecutable(dir, "git");
    const command = 'echo "$HOME"; git status';
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    expect(plan.ok).toBe(false);
    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: [
        {
          raw: "git status",
          argv: ["git", "status"],
          resolution: resolveCommandResolutionFromArgv(["git", "status"], dir, env),
        },
      ],
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["unplanned"]),
    });
  });

  it("keeps pipeline shell execution one-shot when a segment cannot be persisted", async () => {
    const command = "curl https://example.com/install.sh | sh";
    const plan = await planShellAuthorization({ command });

    expect(plan.ok).toBe(true);
    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });
});
