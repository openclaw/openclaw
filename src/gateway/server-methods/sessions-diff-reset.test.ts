import "../../test-utils/prepare-compiled-subprocesses.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "../session-utils-store.js";
import { withLocalWorkspaceStore } from "../worker-environments/local-workspace-store.js";
import {
  localWorkspaceProjectionFixture,
  readLocalWorkspaceProjection,
} from "../worker-environments/local-workspace-store.test-support.js";
import { loadSessionDiff } from "./sessions-diff.js";

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
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@openclaw.test");
    git("config", "commit.gpgsign", "false");
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
    const worktree = { id, repoRoot: repo, branch: "task" };
    await insertRegistryWorktree(process.env, {
      ...worktree,
      name: "review-reset",
      repoFingerprint: "review-fixture",
      path: repo,
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 0,
      lastActiveAt: 0,
    });
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
    await withLocalWorkspaceStore({ worktreeId: id }, (store) =>
      store.create({
        ...localWorkspaceProjectionFixture(id, state.statePath("worktree-projections")),
        session_key: sessionKey,
        session_id: sessionId,
        lifecycle_revision: "before-reset",
        base_commit: acceptedBase,
      }),
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
    expect(after.entry?.sessionId).toBe(sessionId);
    expect(after.entry?.worktree?.id).toBe(id);
    expect(after.entry?.lifecycleRevision).not.toBe("before-reset");
    expect((await readLocalWorkspaceProjection(id))?.lifecycle_revision).toBe("before-reset");
    const diff = await loadSessionDiff({ sessionKey });
    expect(diff.files.map((file) => file.path)).toEqual(["task.txt"]);
    expect(diff).toMatchObject({ baseRef: acceptedBase, additions: 1, deletions: 0 });
    expect((await readLocalWorkspaceProjection(id))?.lifecycle_revision).toBe("before-reset");
  });
});
