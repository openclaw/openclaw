import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import * as worktreeGit from "../agents/worktrees/git.js";
import { requireGit } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import bootstrapExtraFilesHook from "../hooks/bundled/bootstrap-extra-files/handler.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import * as backoff from "../infra/backoff.js";
import { withProjectCheckoutLifecycle } from "../projects/project-checkout.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRequestGate } from "./server-methods.request-gate.test-support.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";

async function initializeWorkspace(workspace: string) {
  await requireGit(workspace, ["init", "-b", "main"]);
  await requireGit(workspace, ["config", "user.name", "Workspace Fixture"]);
  await requireGit(workspace, ["config", "user.email", "fixture@example.invalid"]);
  for (const [file, content] of [
    ["AGENTS.md", "Committed instructions.\n"],
    ["src/remaining.txt", "Complete checkout.\n"],
    ["packages/core/AGENTS.md", "Nested project rules.\n"],
  ] as const) {
    const destination = path.join(workspace, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
  await requireGit(workspace, ["add", "."]);
  await requireGit(workspace, ["commit", "-qm", "prompt fixture"]);
}

it("discovers a new worktree source once while preserving its nested cwd", () =>
  withOpenClawTestState({ label: "worktree-source-discovery" }, async (state) => {
    await initializeWorkspace(state.workspaceDir);
    const relative = "..notes/app";
    const workspace = path.join(state.workspaceDir, relative);
    await fs.mkdir(workspace, { recursive: true });
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace } },
      worktreeAcceleration: false,
    };
    setRuntimeConfigSnapshot(cfg);
    using gitRequests = vi.spyOn(worktreeGit, "runGit");
    const prepared = await prepareSessionWorktree({
      cfg,
      target: {
        agentId: "main",
        key: "agent:main:nested-worktree",
        storePath: path.join(state.sessionsDir(), "sessions.sqlite"),
      },
      workspace,
      baseRef: "HEAD",
      runSetupScript: false,
    });
    assert(prepared.ok, JSON.stringify(prepared));
    try {
      const { sessionRoot, spawnedCwd, worktree } = prepared.value;
      assert(sessionRoot && spawnedCwd && worktree);
      expect(spawnedCwd).toBe(path.join(sessionRoot, relative));
      expect((await fs.stat(spawnedCwd)).isDirectory()).toBe(true);
      expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
        ownerKind: "session",
        ownerId: "agent:main:nested-worktree",
        repoRoot: state.workspaceDir,
      });
      expect(
        gitRequests.mock.calls.filter(
          ([cwd, args]) =>
            cwd === workspace &&
            args.join(" ") === "rev-parse --show-toplevel --verify HEAD^{commit}",
        ),
      ).toHaveLength(1);
    } finally {
      await prepared.value.rollback?.();
    }
  }));

it.each([
  { name: "sandbox", sandboxRequired: true, hookEvent: undefined },
  { name: "configured bootstrap", sandboxRequired: false, hookEvent: "agent:bootstrap" },
  { name: "family bootstrap listener", sandboxRequired: false, hookEvent: "agent" },
])("finishes the $name worktree before exposing its prompt", ({ sandboxRequired, hookEvent }) =>
  withOpenClawTestState({ label: "complete-worktree-prompt" }, async (state) => {
    const workspace = state.workspaceDir;
    await initializeWorkspace(workspace);

    const prompt = createRequestGate();
    const bootstrapFiles = { enabled: true, paths: ["packages/*/AGENTS.md"] };
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace } },
      worktreeAcceleration: false,
      hooks: { internal: { entries: { "bootstrap-extra-files": bootstrapFiles } } },
    };
    setRuntimeConfigSnapshot(cfg);
    if (hookEvent) {
      registerInternalHook(hookEvent, bootstrapExtraFilesHook);
    }
    const target = {
      agentId: "main",
      key: "agent:main:sandbox-worktree",
      storePath: path.join(state.sessionsDir(), "sessions.sqlite"),
      sandboxRequired,
    };
    const preparing = prepareSessionWorktree({
      cfg,
      target,
      workspace,
      baseRef: "HEAD",
      runSetupScript: false,
      onPromptReady: prompt.pause,
    });
    try {
      const prepared = await Promise.race([
        preparing,
        prompt.entered.then(() => assert.fail("Prompt exposed before checkout completed")),
      ]);
      assert(prepared.ok, JSON.stringify(prepared));
      const { worktree, spawnedCwd } = prepared.value;
      assert(worktree && spawnedCwd, "Expected a published worktree");
      expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
        ownerKind: "session",
        ownerId: "agent:main:sandbox-worktree",
      });
      expect(await fs.readFile(path.join(spawnedCwd, "src/remaining.txt"), "utf8")).toBe(
        "Complete checkout.\n",
      );
      if (sandboxRequired) {
        const githubPullRequest = {
          url: "https://github.com/example/project/pull/7",
          host: "github.com",
          number: 7,
          base: {
            repository: "example/project",
            repositoryId: 1,
            branch: "main",
            commit: "a".repeat(40),
          },
          head: {
            repository: "contributor/project",
            repositoryId: 2,
            branch: "feature",
            commit: "b".repeat(40),
          },
          preparedHeadCommit: "b".repeat(40),
        };
        const reused = await prepareSessionWorktree({
          cfg,
          target: {
            ...target,
            entry: {
              sessionId: "workspace-reuse",
              updatedAt: 1,
              worktree: { ...worktree, githubPullRequest },
            },
          },
          workspace,
          runSetupScript: false,
        });
        expect(reused.ok && reused.value.worktree?.githubPullRequest).toEqual(githubPullRequest);
      }
      if (hookEvent) {
        const bootstrap = await resolveBootstrapContextForRun({
          workspaceDir: spawnedCwd,
          config: cfg,
          agentId: "main",
          sessionKey: "agent:main:sandbox-worktree",
        });
        expect(bootstrap.contextFiles).toContainEqual({
          path: path.join(spawnedCwd, "packages/core/AGENTS.md"),
          content: "Nested project rules.",
        });
      }
    } finally {
      if (hookEvent) {
        unregisterInternalHook(hookEvent, bootstrapExtraFilesHook);
      }
      prompt.release();
      const prepared = await preparing;
      if (prepared.ok) {
        await prepared.value.rollback?.();
      }
    }
  }),
);

it("shares source waiting through preparation and final binding without charging protected work", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "worktree-source-wait-budget" }, async (state) => {
    const workspace = state.workspaceDir;
    await requireGit(workspace, ["init", "-b", "main"]);
    await requireGit(workspace, ["config", "user.name", "Workspace Fixture"]);
    await requireGit(workspace, ["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(path.join(workspace, "README.md"), "Preserved workspace.\n");
    await requireGit(workspace, ["add", "README.md"]);
    await requireGit(workspace, ["commit", "-qm", "source wait fixture"]);
    const project = await registerProjectRegistry({ path: workspace });
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace } },
      worktreeAcceleration: false,
    };
    setRuntimeConfigSnapshot(cfg);

    const holders: Array<{ release: () => void; settled: Promise<void> }> = [];
    let waiting: { elapsedMs: number; advanced: boolean; release: () => Promise<void> } | undefined;
    const holdSource = async (elapsedMs: number) => {
      const gate = createRequestGate();
      const settled = withProjectCheckoutLifecycle(project.repoRoot, {}, gate.pause);
      holders.push({ release: gate.release, settled });
      await withinTest(
        awaitGateBeforeSettlement(gate.entered, settled, "Source holder did not acquire custody"),
        signal,
      );
      const release = async () => {
        gate.release();
        await settled;
      };
      waiting = { elapsedMs, advanced: false, release };
      return release;
    };
    let clock = 0;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const sleep = backoff.sleepWithAbort;
    const sleepSpy = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (...args) => {
      const held = waiting;
      if (!held) {
        return sleep(...args);
      }
      if (!held.advanced) {
        held.advanced = true;
        clock += held.elapsedMs;
        return;
      }
      // The actual acquisition loop must remain pending after observing the elapsed wait.
      waiting = undefined;
      await held.release();
    });
    const waitBudget = { remainingMs: 90_000 };
    let prepared: Awaited<ReturnType<typeof prepareSessionWorktree>> | undefined;
    try {
      await holdSource(31_000);
      prepared = await withinTest(
        prepareSessionWorktree({
          cfg,
          target: {
            agentId: "main",
            key: "agent:main:source-wait-budget",
            storePath: path.join(state.sessionsDir(), "sessions.sqlite"),
            projectId: project.id,
            sandboxRequired: true,
          },
          workspace,
          name: "source-wait-budget",
          baseRef: "HEAD",
          runSetupScript: false,
          signal,
          waitBudget,
        }),
        signal,
      );
      assert(prepared.ok, JSON.stringify(prepared));
      const { worktree, spawnedCwd, withCommit } = prepared.value;
      assert(worktree && spawnedCwd && withCommit, "Expected a source-bound completed checkout");
      expect(waitBudget.remainingMs).toBe(59_000);

      await holdSource(31_000);
      expect(
        await withinTest(
          withCommit(async (assertCurrent) => {
            assertCurrent();
            clock += 120_000;
            return fs.readFile(path.join(spawnedCwd, "README.md"), "utf8");
          }),
          signal,
        ),
      ).toBe("Preserved workspace.\n");
      expect(waitBudget.remainingMs).toBe(28_000);

      const release = await holdSource(28_001);
      const commit = vi.fn(async () => "must not run while source is held");
      await expect(withinTest(withCommit(commit), signal)).rejects.toThrow(
        /timed out waiting for capacity or checkout custody/,
      );
      expect(commit).not.toHaveBeenCalled();
      expect(waitBudget.remainingMs).toBe(0);
      await release();
      waiting = undefined;
      expect(
        await withCommit(async (assertCurrent) => {
          assertCurrent();
          return fs.readFile(path.join(spawnedCwd, "README.md"), "utf8");
        }),
      ).toBe("Preserved workspace.\n");
      expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
        id: worktree.id,
        path: spawnedCwd,
        ownerId: "agent:main:source-wait-budget",
      });
      expect(waitBudget.remainingMs).toBe(0);
    } finally {
      waiting = undefined;
      for (const holder of holders) {
        holder.release();
      }
      await Promise.allSettled(holders.map((holder) => holder.settled));
      sleepSpy.mockRestore();
      clockSpy.mockRestore();
      if (prepared?.ok) {
        await prepared.value.rollback?.();
      }
    }
  });
});
