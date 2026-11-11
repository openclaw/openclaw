import "../config/sessions/session-entry-patch-delivery.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { requireGit } from "../agents/worktrees/git.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { adoptUnboundPullRequestWorkspace } from "./session-pr-workspace-adoption.js";

it("adopts the registered base project for a fork PR without replacing earlier files", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    setRuntimeConfigSnapshot(cfg);
    const repoRoot = path.join(state.workspaceDir, "project");
    await fs.mkdir(repoRoot);
    await requireGit(repoRoot, ["init", "-b", "main"]);
    await fs.writeFile(path.join(repoRoot, "source.txt"), "project history\n");
    await requireGit(repoRoot, ["add", "source.txt"]);
    await requireGit(repoRoot, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "base",
    ]);
    await requireGit(repoRoot, ["remote", "add", "origin", "https://github.com/example/repo.git"]);
    const project = await registerProjectRegistry({ path: repoRoot });
    // Registry owns source identity; this fixture needs no external transport.
    await requireGit(repoRoot, ["remote", "remove", "origin"]);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:fork-base",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    await upsertSessionEntryCore(target, {
      sessionId: "fork-base",
      updatedAt: 1,
      sessionRoot: state.workspaceDir,
    });
    const manager = await SessionManager.openAsync(
      { ...target, sessionId: "fork-base" },
      state.workspaceDir,
    );
    await manager.appendMessageAsync(
      makeUserMessage("Prepare https://github.com/example/repo/pull/1 from guest/repo", 1),
    );
    await fs.writeFile(path.join(state.workspaceDir, "notes.txt"), "earlier notes\n");
    try {
      const adopted = await adoptUnboundPullRequestWorkspace({
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        target,
        entry: loadSessionEntryReadOnly(target)!,
        sandbox: createSandboxTestContext({
          overrides: {
            sessionKey: target.sessionKey,
            workspaceDir: state.workspaceDir,
            workspaceSource: undefined,
          },
        }),
        projectSource: {
          host: "github.com",
          repository: "example/repo",
          requester: { kind: "internal" },
        },
        assertCurrent() {},
      });
      expect(adopted.projectId).toBe(project.id);
      expect(adopted.worktree?.repoRoot).toBe(project.repoRoot);
      expect(
        await requireGit(adopted.spawnedCwd!, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      ).toBe(path.join(project.repoRoot, ".git"));
      expect(await fs.readFile(path.join(adopted.spawnedCwd!, "source.txt"), "utf8")).toBe(
        "project history\n",
      );
      expect(await fs.readFile(path.join(state.workspaceDir, "notes.txt"), "utf8")).toBe(
        "earlier notes\n",
      );
      expect(adopted.priorWorkspace?.fileRoot).toBe(state.workspaceDir);
    } finally {
      const worktree = await managedWorktrees.findLiveByOwner("session", target.sessionKey);
      if (worktree) {
        await managedWorktrees.remove({
          id: worktree.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    }
  });
});
