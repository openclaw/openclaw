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

async function decideCommand(
  command: string,
  options: Pick<Parameters<typeof planShellAuthorization>[0], "cwd" | "env"> = {},
) {
  const plan = await planShellAuthorization({ command, ...options });
  return resolveAllowAlwaysPersistenceDecision({
    segments: plannedSegments(plan),
    commandText: command,
    platform: process.platform,
    authorizationPlan: plan,
    ...options,
  });
}

function expectOneShotApproval(
  decision: ReturnType<typeof resolveAllowAlwaysPersistenceDecision>,
  reason = "no-reusable-pattern",
) {
  expect(decision).toEqual({ kind: "one-shot", reasons: expect.arrayContaining([reason]) });
  expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
    "allow-once",
    "deny",
  ]);
}

function createPersistenceFixture(binaries: string[]) {
  const dir = makeExecApprovalsTempDir();
  for (const executable of binaries) {
    makeExecutable(dir, executable);
  }
  const env = makePathEnv(dir);
  return { dir, decide: (command: string) => decideCommand(command, { cwd: dir, env }) };
}

describe("resolveAllowAlwaysPersistenceDecision", () => {
  it.each([
    [["pnpm", "tsx"], "pnpm -C ./package exec -- tsx ./run.ts"],
    [["pnpm", "tsx"], "pnpm dlx --allow-build=tsx tsx ./run.ts"],
    [["pnpm", "npm", "sh", "echo"], "pnpm exec -- npm x sh -c 'echo warmup-ok'"],
    [["yarn", "sh", "echo"], "yarn sh -c 'echo warmup-ok'"],
    [["env", "nice", "pnpm", "sh", "echo"], "nice pnpm exec sh -c 'echo warmup-ok'"],
    [["env", "pnpm"], `env -- pnpm exec --shell-mode "sh -c 'echo warmup-ok'"`],
    [["npx"], `npx --call "sh -c 'echo warmup-ok'"`],
  ] satisfies [string[], string][])("keeps %j / %s one-shot", async (binaries, command) => {
    const { decide } = createPersistenceFixture(binaries);
    expectOneShotApproval(await decide(command));
  });

  it.each([
    { binaries: [], executable: "git", command: "git status" },
    { binaries: ["pnpm", "npm"], executable: "tsx", command: "pnpm exec -- npm x -- tsx ./run.ts" },
    { binaries: ["yarn"], executable: "tsx", command: "yarn dlx tsx ./run.ts" },
  ])("persists $command against $executable", async ({ binaries, executable, command }) => {
    const { dir, decide } = createPersistenceFixture(binaries);
    const executablePath = makeExecutable(dir, executable);
    expect(await decide(command)).toEqual({
      kind: "patterns",
      commandText: command,
      patterns: [expect.objectContaining({ pattern: executablePath })],
    });
  });

  it.each([true, false])("keeps script wrappers one-shot with approved cwd: %s", async (hasCwd) => {
    expectOneShotApproval(
      await decideCommand("sh -c './scripts/run.sh'", {
        cwd: hasCwd ? makeExecApprovalsTempDir() : undefined,
      }),
    );
  });

  it.each(["bash --login -c 'echo ok'", "bash -i -c 'echo ok'"])(
    "keeps startup shell wrappers one-shot: %s",
    async (command) => {
      expectOneShotApproval(await decideCommand(command));
    },
  );

  it.each([
    { command: 'eval "$CMD"', reason: "prompt-only" },
    { command: 'sh -c "$SCRIPT"', reason: "runtime-payload" },
    { command: "sh -c '$0 \"$@\"' xargs echo SAFE", reason: "runtime-payload" },
  ] as const)("keeps $command allow-always approvals one-shot", async ({ command, reason }) => {
    expectOneShotApproval(await decideCommand(command), reason);
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

    expectOneShotApproval(decision, "unplanned");
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
    expectOneShotApproval(decision);
  });
});
