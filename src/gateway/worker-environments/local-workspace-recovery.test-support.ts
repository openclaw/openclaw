import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

export async function proveOversizedWorkspaceRecovery({
  owner,
  canonical,
  stateRoot,
}: {
  owner: LocalWorkspaceOwner;
  canonical: string;
  stateRoot: string;
}) {
  const { prepareLocalSandboxWorkspace } = await import("../../agents/sandbox/local-workspace.js");
  const { resolveSandboxConfigForAgent } = await import("../../agents/sandbox/config.js");
  const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
  const cfg = {
    worktreeAcceleration: false,
    session: { store: path.join(stateRoot, "sessions.json") },
  };
  await replaceSessionEntry(
    { agentId: owner.agentId, sessionKey: owner.sessionKey, storePath: cfg.session.store },
    {
      sessionId: owner.sessionId,
      updatedAt: 1,
      worktree: {
        id: owner.worktree.id,
        branch: owner.worktree.branch,
        repoRoot: owner.worktree.repoRoot,
      },
    },
  );
  const prepareSandbox = () =>
    prepareLocalSandboxWorkspace({
      cfg,
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      workspaceDir: canonical,
      sandbox: resolveSandboxConfigForAgent(cfg, owner.agentId),
    });
  const first = await prepareSandbox();
  expect(first).toBeDefined();
  const projection = first!.workspaceDir;
  const artifact = path.join(projection, "artifacts/archive.tgz");
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, "retained binary contents\n");
  await fs.truncate(artifact, 64 * 1024 * 1024 + 1);
  await fs.writeFile(path.join(projection, "source.txt"), "guest source remains recoverable\n");
  await expect(first!.checkpoint()).rejects.toThrow(
    "Cloud workspace result is too large: artifacts/archive.tgz",
  );
  first![Symbol.dispose]();
  const pending = await readLocalWorkspaceProjection(owner.worktree.id);
  expect(pending).toMatchObject({ pending_target: "canonical" });
  expect(pending!.pending_ref).toBeTruthy();
  for (const message of ["Hello", "Continue"]) {
    await expect(prepareSandbox(), message).rejects.toThrow(
      "Cloud workspace result is too large: artifacts/archive.tgz",
    );
    expect((await readLocalWorkspaceProjection(owner.worktree.id))!.pending_ref).toBe(
      pending!.pending_ref,
    );
  }
  expect((await fs.stat(artifact)).size).toBe(64 * 1024 * 1024 + 1);
  expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe("original\n");
  const { recoverLocalWorkspaceFile } = await import("./local-workspace-recovery.js");
  const recovery = {
    cfg,
    sessionKey: owner.sessionKey,
    path: "artifacts/archive.tgz",
    recoveryId: randomUUID(),
    assertCurrent: owner.assertCurrent,
  };
  await expect(recoverLocalWorkspaceFile({ ...recovery, path: "../source.txt" })).rejects.toThrow(
    "unsafe path",
  );
  await expect(recoverLocalWorkspaceFile({ ...recovery, path: "source.txt" })).rejects.toThrow(
    "already admitted",
  );
  await fs.symlink(artifact, path.join(projection, "alias"));
  await expect(recoverLocalWorkspaceFile({ ...recovery, path: "alias" })).rejects.toThrow();
  await fs.unlink(path.join(projection, "alias"));
  await fs.link(artifact, path.join(projection, "hardlink"));
  await expect(recoverLocalWorkspaceFile(recovery)).rejects.toThrow();
  await fs.unlink(path.join(projection, "hardlink"));
  const recovered = await recoverLocalWorkspaceFile(recovery);
  expect(await recoverLocalWorkspaceFile(recovery)).toEqual(recovered);
  const relocated = recovered.path;
  expect(recovered.bytes).toBe(64 * 1024 * 1024 + 1);
  await expect(fs.stat(path.join(projection, recovery.path))).rejects.toMatchObject({
    code: "ENOENT",
  });
  using resumed = await prepareSandbox();
  expect(resumed).toBeDefined();
  expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe(
    "guest source remains recoverable\n",
  );
  expect((await fs.stat(relocated)).size).toBe(64 * 1024 * 1024 + 1);
  const recoveredFile = await fs.open(relocated, "r");
  try {
    const prefix = Buffer.alloc(25);
    await recoveredFile.read(prefix, 0, prefix.length, 0);
    expect(prefix.toString()).toBe("retained binary contents\n");
  } finally {
    await recoveredFile.close();
  }
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    pending_ref: null,
    pending_target: null,
  });
}
