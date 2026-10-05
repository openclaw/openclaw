import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assertRequiredSessionWorktree,
  REQUIRED_WORKTREE_UNAVAILABLE,
} from "./required-session-binding.js";
import type { ManagedWorktreeRecord } from "./types.js";

test("required execution binds its concrete checkout and rejects path or registry replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const root = await fs.realpath(state.workspaceDir);
    const sessionKey = "agent:main:workspace-owner";
    const record: ManagedWorktreeRecord = {
      id: "required-worktree",
      name: "required",
      path: root,
      repoRoot: root,
      repoFingerprint: "fixture-repo",
      branch: "openclaw/required",
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 1,
      lastActiveAt: 1,
    };
    const entry: SessionEntry = {
      sessionId: "original-parent",
      lifecycleRevision: "original-generation",
      updatedAt: 1,
      createdVia: "operator",
      requiredWorkspace: { projectId: "workspace:main", worktreeBaseRef: "main" },
      projectId: "workspace:main",
      sessionRoot: root,
      spawnedCwd: root,
      spawnedWorkspaceDir: root,
      worktree: {
        id: record.id,
        repoRoot: root,
        branch: record.branch,
        canonicalWorkspaceDir: root,
      },
    };
    const input = { entry, sessionKey, record, candidatePaths: [root] };
    await expect(assertRequiredSessionWorktree(input)).resolves.toBeUndefined();
    for (const changed of [
      { record: undefined },
      { record: { ...record, removedAt: 2 } },
      { record: { ...record, ownerId: "agent:main:somebody-else" } },
      { record: { ...record, baseRef: "HEAD" } },
      { record: { ...record, branch: "main" } },
      { candidatePaths: [path.dirname(root)] },
      { entry: { ...entry, execHost: "node", execNode: "alternate" } },
    ]) {
      await expect(assertRequiredSessionWorktree({ ...input, ...changed })).rejects.toThrow(
        REQUIRED_WORKTREE_UNAVAILABLE,
      );
    }
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
    const child: SessionEntry = {
      ...entry,
      sessionId: "joined-child",
      createdVia: "spawn",
      parentSessionKey: sessionKey,
      parentSessionId: entry.sessionId,
      parentLifecycleRevision: entry.lifecycleRevision,
    };
    const joined = { ...input, entry: child, sessionKey: "agent:main:subagent:child" };
    // A configured-store relocation must still resolve the retained parent's default store.
    const bindings = [
      joined,
      {
        ...joined,
        cfg: {
          session: {
            store: path.join(state.root, "relocated", "{agentId}", "sessions", "sessions.json"),
          },
        },
      },
    ];
    for (const binding of bindings) {
      await expect(assertRequiredSessionWorktree(binding)).resolves.toBeUndefined();
    }
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { lifecycleRevision: "reset-generation" },
    );
    for (const binding of bindings) {
      await expect(assertRequiredSessionWorktree(binding)).rejects.toThrow(
        REQUIRED_WORKTREE_UNAVAILABLE,
      );
    }
  });
});
