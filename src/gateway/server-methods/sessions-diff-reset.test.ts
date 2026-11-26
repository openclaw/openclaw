import "../../test-utils/prepare-compiled-subprocesses.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "../session-utils-store.js";
import { readLocalWorkspaceProjection } from "../worker-environments/local-workspace-store.test-support.js";
import { loadSessionDiff } from "./sessions-diff.js";
import { initRepo, seedManagedReview } from "./sessions-diff.test-support.js";

afterEach(() => resetPluginRuntimeStateForTest());

it("reads the accepted base immediately after a real same-session reset", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const repo = state.workspaceDir;
    const cfg = {
      agents: { entries: { main: { workspace: repo } } },
      session: { maintenance: { mode: "warn" as const } },
    };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    initRepo(repo);
    await fs.writeFile(path.join(repo, "base.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const staleBase = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", staleBase);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await fs.writeFile(path.join(repo, "upstream.txt"), "upstream only\n");
    git("add", ".");
    git("commit", "-qm", "accepted upstream");
    const acceptedBase = git("rev-parse", "HEAD");
    git("checkout", "-qb", "task");
    await fs.writeFile(path.join(repo, "task.txt"), "authored change\n");
    const id = randomUUID();
    const sessionId = randomUUID();
    const sessionKey = "agent:main:review-reset";
    const worktree = {
      id,
      repoRoot: repo,
      branch: "task",
      githubPullRequest: {
        url: "https://github.com/example/project/pull/7",
        host: "github.com",
        number: 7,
        origin: "external-pr" as const,
        base: {
          repository: "example/project",
          repositoryId: 1,
          branch: "main",
          commit: acceptedBase,
        },
        head: {
          repository: "example/project",
          repositoryId: 1,
          branch: "task",
          commit: acceptedBase,
        },
        preparedHeadCommit: acceptedBase,
      },
    };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId,
        updatedAt: 1,
        lifecycleRevision: "before-reset",
        spawnedCwd: repo,
        worktree,
      },
    );
    await seedManagedReview(
      worktree,
      { sessionKey, sessionId, lifecycleRevision: "before-reset" },
      state.statePath("worktree-projections"),
      acceptedBase,
      "review-reset",
    );
    expect((await loadSessionDiff({ sessionKey })).files.map((file) => file.path)).toEqual([
      "task.txt",
    ]);
    const reset = await performGatewaySessionReset({
      key: sessionKey,
      agentId: "main",
      reason: "reset",
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      workerPlacementContext: {},
    });
    expect(reset).toMatchObject({ ok: true });
    const after = await loadGatewaySessionEntryReadOnlyAsync(sessionKey, { agentId: "main" }, cfg);
    expect(after.entry).toMatchObject({ sessionId, worktree });
    expect(after.entry?.lifecycleRevision).not.toBe("before-reset");
    expect((await readLocalWorkspaceProjection(id))?.lifecycle_revision).toBe("before-reset");
    const diff = await loadSessionDiff({ sessionKey });
    expect(diff.files.map((file) => file.path)).toEqual(["task.txt"]);
    expect(diff).toMatchObject({ baseRef: acceptedBase, additions: 1, deletions: 0 });
    expect((await readLocalWorkspaceProjection(id))?.lifecycle_revision).toBe("before-reset");
  });
});

it.each([false, true])("shows no changes before the first turn (managed: %s)", async (managed) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const repo = state.workspaceDir;
    const cfg = { agents: { entries: { main: { workspace: repo } } } };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    initRepo(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    for (const name of ["base", "committed"]) {
      await fs.writeFile(path.join(repo, `${name}.txt`), `${name}\n`);
      git("add", ".");
      git("commit", "-qm", name);
      if (name === "base") {
        git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
        git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
        git("checkout", "-qb", "task");
      }
    }
    const commit = git("rev-parse", "HEAD");
    // Pre-session work in the agent workspace is not this conversation's change.
    await fs.writeFile(path.join(repo, "before-session.txt"), "existing\n");
    const sessionKey = "agent:main:main";
    const { sessionEntry } = await initSessionState({
      ctx: finalizeInboundContext({
        Body: "hello",
        ChatType: "direct",
        SessionKey: sessionKey,
        SessionCreation: { via: "operator", actor: { type: "human", id: "profile-ada" } },
      }),
      cfg,
      commandAuthorized: true,
    });
    const worktree = managed ? { id: randomUUID(), repoRoot: repo, branch: "task" } : undefined;
    if (worktree) {
      await upsertSessionEntryCore(
        { sessionKey, agentId: "main" },
        { ...sessionEntry, worktree, spawnedCwd: repo },
      );
      await seedManagedReview(
        worktree,
        { sessionKey, sessionId: sessionEntry.sessionId },
        state.statePath("worktree-projections"),
        git("rev-parse", "refs/remotes/origin/main"),
      );
    }
    expect(await loadSessionDiff({ sessionKey })).toMatchObject({ files: [], additions: 0 });
    const named = await loadSessionDiff({ sessionKey, scope: "commit", commit });
    expect(named.files.map((file) => file.path)).toEqual(["committed.txt"]);
    if (worktree) {
      await updateRegistryWorktree(process.env, worktree.id, { removedAt: 0 });
      await expect(loadSessionDiff({ sessionKey })).rejects.toThrow(
        /worktree was removed.*Use Restore in Settings > Worktrees/,
      );
    }
  });
});
