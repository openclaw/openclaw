import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { requireGit } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";

// Gateway fork workers own the shared-state broker required by real worktree preparation.
it("publishes a sandbox worktree before exposing its prompt", async () => {
  await withOpenClawTestState({ label: "sandbox-worktree-prompt" }, async (state) => {
    const workspace = state.workspaceDir;
    await fs.mkdir(workspace, { recursive: true });
    await requireGit(workspace, ["init", "-b", "main"]);
    await requireGit(workspace, ["config", "user.name", "Workspace Fixture"]);
    await requireGit(workspace, ["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "Committed instructions.\n");
    await fs.mkdir(path.join(workspace, "src"));
    await fs.writeFile(path.join(workspace, "src/remaining.txt"), "Complete checkout.\n");
    await requireGit(workspace, ["add", "."]);
    await requireGit(workspace, ["commit", "-qm", "sandbox fixture"]);

    const promptExposed = createDeferredCore();
    const releaseCheckout = createDeferredCore();
    const preparing = prepareSessionWorktree({
      cfg: { agents: { defaults: { workspace } }, worktreeAcceleration: false },
      target: {
        agentId: "main",
        key: "agent:main:sandbox-worktree",
        storePath: path.join(state.sessionsDir(), "sessions.sqlite"),
        sandboxRequired: true,
      },
      workspace,
      baseRef: "HEAD",
      runSetupScript: false,
      onPromptReady: async () => {
        promptExposed.resolve();
        await releaseCheckout.promise;
      },
    });
    try {
      const first = await Promise.race([
        preparing.then(() => "prepared"),
        promptExposed.promise.then(() => "early prompt"),
      ]);
      expect(first).toBe("prepared");
      const prepared = await preparing;
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      if (!prepared.ok || !prepared.value.worktree || !prepared.value.spawnedCwd) {
        throw new Error("Expected a published sandbox worktree");
      }
      expect(getRegistryWorktree(process.env, prepared.value.worktree.id)).toMatchObject({
        ownerKind: "session",
        ownerId: "agent:main:sandbox-worktree",
      });
      expect(
        await fs.readFile(path.join(prepared.value.spawnedCwd, "src/remaining.txt"), "utf8"),
      ).toBe("Complete checkout.\n");
    } finally {
      releaseCheckout.resolve();
      const prepared = await preparing;
      if (prepared.ok) {
        await prepared.value.rollback?.();
      }
    }
  });
});
