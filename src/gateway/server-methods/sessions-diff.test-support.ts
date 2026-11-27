import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withLocalWorkspaceStore } from "../worker-environments/local-workspace-store.js";
import { localWorkspaceProjectionFixture } from "../worker-environments/local-workspace-store.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

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

export function createDiffRepositoryFixture(repoRoot: () => string) {
  const repoGit = (...args: string[]) => git(repoRoot(), ...args);
  const write = (name: string, data: string | Buffer) =>
    fs.writeFileSync(path.join(repoRoot(), name), data);
  const append = (name: string, data: string) =>
    fs.appendFileSync(path.join(repoRoot(), name), data);
  const commitFiles = (message = "init", files = ".") => {
    repoGit("add", files);
    repoGit("commit", "-qm", message);
  };
  const revision = () => repoGit("rev-parse", "HEAD").trim();
  const initFiles = (files: Record<string, string | Buffer>, format?: "sha1" | "sha256") => {
    initRepo(repoRoot(), format);
    for (const [name, data] of Object.entries(files)) {
      write(name, data);
    }
  };
  const seedRepo = (
    files: Record<string, string | Buffer>,
    subject = "init",
    format?: "sha1" | "sha256",
  ) => {
    initFiles(files, format);
    commitFiles(subject);
  };
  return { repoGit, write, append, commitFiles, revision, initFiles, seedRepo };
}

export const filePaths = (result: { files: Array<{ path: string }> } | undefined) =>
  result?.files.map((file) => file.path);
export const changedFile = (name: string, status: string, additions: number, deletions = 0) => ({
  path: name,
  status,
  additions,
  deletions,
});
export const addedFile = (name: string, additions: number, flags: Record<string, boolean>) => ({
  ...changedFile(name, "added", additions),
  untracked: true,
  ...flags,
});

export async function callSessionsDiff(
  handler: (params: GatewayRequestHandlerOptions) => unknown,
  params: Record<string, unknown>,
  cfg: OpenClawConfig = {},
  reqParams: Record<string, unknown> = {},
  authority: Partial<
    Pick<GatewayRequestHandlerOptions, "client" | "hasCurrentClientAuthority">
  > = {},
) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await handler({
    req: { type: "req", id: "sessions.diff", method: "sessions.diff", params: reqParams },
    params,
    client: null,
    ...authority,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    context: {
      getRuntimeConfig: () => cfg,
      logGateway: createSubsystemLogger("test/sessions-diff"),
    } as never,
  });
  return calls;
}
