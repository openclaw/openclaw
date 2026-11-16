import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { requireGit } from "../../agents/worktrees/git.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "../worker-environments/local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "../worker-environments/local-workspace-types.js";
import {
  cfg,
  seedMessageCutSource,
  type SourceScope,
} from "./sessions-rewind.storage.test-support.js";

type Fixture = {
  scope: SourceScope;
  worktree: ManagedWorktreeRecord;
  canonical: string;
  projection: string;
  original: LocalWorkspaceOwner & Disposable;
};

export async function withMessageCutLocalWorkspace(
  run: (fixture: Fixture) => Promise<void>,
  incognito = false,
) {
  await withOpenClawTestState({ label: "message-cut-local-workspace" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource(incognito);
    const repo = state.path("source");
    const canonical = state.path("canonical");
    const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
    await fs.mkdir(repo);
    await git(repo, "init", "--quiet", "-b", "main");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "user.email", "test@example.invalid");
    await fs.writeFile(path.join(repo, "source.txt"), "original\n");
    await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "--quiet", "-m", "base");
    await git(repo, "worktree", "add", "--quiet", "-b", "openclaw/guest", canonical);
    const worktree = {
      id: randomUUID(),
      name: "guest",
      repoFingerprint: "test",
      repoRoot: repo,
      path: canonical,
      branch: "openclaw/guest",
      baseRef: "main",
      ownerKind: "session" as const,
      ownerId: scope.sessionKey,
      createdAt: 0,
      lastActiveAt: 0,
    };
    await insertRegistryWorktree(state.env, worktree);
    await patchSessionEntryCore(scope, (entry) => ({
      ...entry,
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: repo },
      spawnedCwd: canonical,
    }));
    using original = expectDefined(
      await resolveLocalWorkspaceOwner({ cfg, ...scope }),
      "managed workspace owner",
    );
    const projection = await withLocalWorkspaceProjection(original, (workspace) =>
      workspace.prepare(),
    );
    await fs.writeFile(path.join(projection, "source.txt"), "stopped turn edit\n");
    await fs.writeFile(path.join(projection, "ignored.txt"), "guest-only ignored data\n");
    await run({ scope, worktree, canonical, projection, original });
  });
}
