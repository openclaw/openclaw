// Tests shared allow-always persistence decisions for command authorization plans.
import { describe, expect, it } from "vitest";
import { resolveCommandResolutionFromArgv } from "./exec-approvals-analysis.js";
import {
  makeExecutable,
  makePathEnv,
  makeExecApprovalsTempDir,
} from "./exec-approvals-test-helpers.js";
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

function createPersistenceFixture(binaries: string[]) {
  const dir = makeExecApprovalsTempDir();
  for (const executable of binaries) {
    makeExecutable(dir, executable);
  }
  const env = makePathEnv(dir);
  return {
    dir,
    decide: async (command: string) => {
      const plan = await planShellAuthorization({ command, cwd: dir, env });
      return resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });
    },
  };
}

describe("resolveAllowAlwaysPersistenceDecision", () => {
  it("chooses reusable patterns for allow-always planner candidates", async () => {
    const { dir, decide } = createPersistenceFixture([]);
    const gitPath = makeExecutable(dir, "git");

    const decision = await decide("git status");

    expect(decision).toEqual({
      kind: "patterns",
      commandText: "git status",
      patterns: [expect.objectContaining({ pattern: gitPath })],
    });
  });

  it("keeps pnpm cwd exec approvals one-shot", async () => {
    const { decide } = createPersistenceFixture(["pnpm", "tsx"]);
    const command = "pnpm -C ./package exec -- tsx ./run.ts";

    const decision = await decide(command);

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it("keeps pnpm dlx allow-build approvals one-shot", async () => {
    const { decide } = createPersistenceFixture(["pnpm", "tsx"]);
    const command = "pnpm dlx --allow-build=tsx tsx ./run.ts";

    const decision = await decide(command);

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it("persists chained package-manager exec approvals against the final inner executable", async () => {
    const { dir, decide } = createPersistenceFixture(["pnpm", "npm"]);
    const tsxPath = makeExecutable(dir, "tsx");
    const command = "pnpm exec -- npm x -- tsx ./run.ts";

    const decision = await decide(command);

    expect(decision).toEqual({
      kind: "patterns",
      commandText: command,
      patterns: [expect.objectContaining({ pattern: tsxPath })],
    });
  });

  it.each(["dlx"])(
    "persists yarn %s approvals against the inner executable",
    async (subcommand) => {
      const { dir, decide } = createPersistenceFixture(["yarn"]);
      const tsxPath = makeExecutable(dir, "tsx");
      const command = `yarn ${subcommand} tsx ./run.ts`;

      const decision = await decide(command);

      expect(decision).toEqual({
        kind: "patterns",
        commandText: command,
        patterns: [expect.objectContaining({ pattern: tsxPath })],
      });
    },
  );

  it("keeps chained package-manager shell carriers one-shot", async () => {
    const { decide } = createPersistenceFixture(["pnpm", "npm", "sh", "echo"]);
    const command = "pnpm exec -- npm x sh -c 'echo warmup-ok'";

    const decision = await decide(command);

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it.each(["yarn sh -c 'echo warmup-ok'"])(
    "keeps yarn script or bin fallback carriers one-shot: %s",
    async (command) => {
      const { decide } = createPersistenceFixture(["yarn", "sh", "echo"]);

      const decision = await decide(command);

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it.each(["nice"])(
    "keeps dispatch-wrapped package-manager shell carriers one-shot: %s",
    async (wrapper) => {
      const { decide } = createPersistenceFixture(["env", "nice", "pnpm", "sh", "echo"]);
      const command = `${wrapper} pnpm exec sh -c 'echo warmup-ok'`;

      const decision = await decide(command);

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it.each([{ flag: "--shell-mode", wrapper: "env --" }])(
    "keeps pnpm shell-mode exec approvals one-shot: $wrapper pnpm exec $flag",
    async ({ flag, wrapper }) => {
      const { decide } = createPersistenceFixture(["env", "pnpm"]);
      const command = `${wrapper} pnpm exec ${flag} "sh -c 'echo warmup-ok'"`.trim();

      const decision = await decide(command);

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it("keeps package-manager shell-call modes one-shot", async () => {
    const { decide } = createPersistenceFixture(["npx"]);
    const command = "npx --call \"sh -c 'echo warmup-ok'\"";

    const decision = await decide(command);

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it("keeps shell wrappers without reusable patterns one-shot", async () => {
    const cwd = makeExecApprovalsTempDir();
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
    const dir = makeExecApprovalsTempDir();
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
