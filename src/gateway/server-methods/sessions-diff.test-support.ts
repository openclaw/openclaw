import { execFileSync } from "node:child_process";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { withLocalWorkspaceStore } from "../worker-environments/local-workspace-store.js";
import { localWorkspaceProjectionFixture } from "../worker-environments/local-workspace-store.test-support.js";

export async function seedManagedReview(
  worktree: { id: string; repoRoot: string; branch: string },
  owner: { sessionKey: string; sessionId: string; lifecycleRevision?: string },
  projectionRoot: string,
  baseCommit: string,
  name = "review",
) {
  await insertRegistryWorktree(process.env, {
    ...worktree,
    name,
    repoFingerprint: "review-fixture",
    path: worktree.repoRoot,
    baseRef: "main",
    ownerKind: "session",
    ownerId: owner.sessionKey,
    createdAt: 0,
    lastActiveAt: 0,
  });
  await withLocalWorkspaceStore({ worktreeId: worktree.id }, (store) =>
    store.create({
      ...localWorkspaceProjectionFixture(worktree.id, projectionRoot),
      session_key: owner.sessionKey,
      session_id: owner.sessionId,
      ...(owner.lifecycleRevision ? { lifecycle_revision: owner.lifecycleRevision } : {}),
      base_commit: baseCommit,
    }),
  );
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

export function initRepo(root: string, objectFormat?: "sha1" | "sha256"): void {
  const args = ["init", "-q", "-b", "main"];
  if (objectFormat) {
    args.push(`--object-format=${objectFormat}`);
  }
  git(root, ...args);
  git(root, "config", "user.email", "test@openclaw.test");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
}

export const fixedStoreConfig = () =>
  ({
    session: { store: "/tmp/shared.sqlite", scope: "global" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
  }) as const;
