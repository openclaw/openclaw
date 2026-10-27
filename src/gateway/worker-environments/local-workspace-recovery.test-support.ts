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
  const sourceText = "guest source remains recoverable\n";
  const oversizedBytes = 64 * 1024 * 1024 + 1;
  const readProjection = () => readLocalWorkspaceProjection(owner.worktree.id);
  const relativePath = ".artifacts/beta's build/package.tgz";
  const artifact = path.join(projection, relativePath);
  const guidance =
    `Pending workspace changes were preserved. Ask a Gateway administrator to run:\n` +
    `openclaw sandbox recover --session '${owner.sessionKey}' --path '.artifacts/beta'"'"'s build/package.tgz'`;
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, "retained binary contents\n");
  await fs.truncate(artifact, oversizedBytes);
  await fs.writeFile(path.join(projection, "source.txt"), sourceText);
  const failures: unknown[] = [await first!.checkpoint().catch((error: unknown) => error)];
  first![Symbol.dispose]();
  const pending = await readProjection();
  expect(pending).toMatchObject({ pending_target: "canonical" });
  expect(pending!.pending_ref).toBeTruthy();
  for (let attempt = 0; attempt < 2; attempt++) {
    failures.push(await prepareSandbox().catch((error: unknown) => error));
    expect((await readProjection())!.pending_ref).toBe(pending!.pending_ref);
  }
  expect((await fs.stat(artifact)).size).toBe(oversizedBytes);
  expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe("original\n");
  const { recoverLocalWorkspaceFile } = await import("./local-workspace-recovery.js");
  const recovery = {
    cfg,
    sessionKey: owner.sessionKey,
    path: relativePath,
    recoveryId: randomUUID(),
    assertCurrent: owner.assertCurrent,
  };
  const recover = (selectedPath = recovery.path) =>
    recoverLocalWorkspaceFile({ ...recovery, path: selectedPath });
  await expect(recover("../source.txt")).rejects.toThrow("unsafe path");
  await expect(recover("source.txt")).rejects.toThrow("already admitted");
  await fs.symlink(artifact, path.join(projection, "alias"));
  await expect(recover("alias")).rejects.toThrow();
  await fs.unlink(path.join(projection, "alias"));
  await fs.link(artifact, path.join(projection, "hardlink"));
  await expect(recover()).rejects.toThrow();
  const linkedFailure = await prepareSandbox().catch((error: unknown) => error);
  expect(linkedFailure).toBeInstanceOf(Error);
  expect(String(linkedFailure)).not.toContain("openclaw sandbox recover");
  await fs.unlink(path.join(projection, "hardlink"));
  const recovered = await recover();
  expect(await recover()).toEqual(recovered);
  const relocated = recovered.path;
  expect(recovered.bytes).toBe(oversizedBytes);
  await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  using resumed = await prepareSandbox();
  expect(resumed).toBeDefined();
  expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe(sourceText);
  expect((await fs.stat(relocated)).size).toBe(oversizedBytes);
  {
    await using recoveredFile = await fs.open(relocated, "r");
    const prefix = Buffer.alloc(25);
    await recoveredFile.read(prefix, 0, prefix.length, 0);
    expect(prefix.toString()).toBe("retained binary contents\n");
  }
  expect(await readProjection()).toMatchObject({
    pending_ref: null,
    pending_target: null,
  });
  // Existing source must not be advertised as eligible for artifact relocation.
  const source = path.join(projection, "source.txt");
  await fs.truncate(source, oversizedBytes);
  const sourceFailure = await resumed!.checkpoint().catch((error: unknown) => error);
  await fs.writeFile(source, sourceText);
  await resumed!.checkpoint();
  expect(sourceFailure).toBeInstanceOf(Error);
  expect(String(sourceFailure)).toBe("Error: Cloud workspace result is too large: source.txt");
  for (const failure of failures) {
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(guidance);
  }
}
