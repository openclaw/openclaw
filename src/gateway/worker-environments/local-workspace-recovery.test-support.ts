import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { stagedInputDirectory, STAGED_INPUT_GITIGNORE } from "../../media/staged-inputs.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { decodeLocalWorkspaceTree, localWorkspaceDigestBytes } from "./local-workspace-cas.js";
import { readLocalWorkspaceTree } from "./local-workspace-cas.kernel.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const writeText = (root: string, relative: string, data: string) =>
  fs.writeFile(path.join(root, relative), data);
const expectText = async (root: string, relative: string, expected: string) => {
  expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(expected);
};
const expectMissing = async (root: string, relative: string) => {
  await expect(fs.stat(path.join(root, relative))).rejects.toMatchObject({ code: "ENOENT" });
};

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
  expect(recovered).toEqual({
    path: path.join(
      stateRoot,
      "workspace-recovery",
      owner.worktree.id,
      recovery.recoveryId,
      relativePath,
    ),
    bytes: oversizedBytes,
  });
  const originalBytes = Buffer.alloc(oversizedBytes);
  originalBytes.write("retained binary contents\n");
  expect((await fs.readFile(recovered.path)).equals(originalBytes)).toBe(true);
  expect(await recover()).toEqual(recovered);
  const relocated = recovered.path;
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

export async function proveAggregateWorkspaceRecovery({
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
  const { recoverLocalWorkspaceFile } = await import("./local-workspace-recovery.js");
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
  const admitted = "src/Existing/bin/input.txt";
  await fs.mkdir(path.join(canonical, "src/Existing/bin"), { recursive: true });
  await fs.writeFile(path.join(canonical, admitted), "original admitted input\n");
  await fs.writeFile(path.join(canonical, "src/Existing/Existing.csproj"), "<Project />\n");
  await requireGit(canonical, ["add", admitted, "src/Existing/Existing.csproj"]);
  const first = await prepareSandbox();
  const projection = first!.workspaceDir;
  // Real aggregate budget, individually valid files: no limit override can hide a staging bypass.
  const artifactBytes = Math.ceil((768 * 1024 * 1024) / 13);
  const artifacts = Array.from(
    { length: 13 },
    (_, index) =>
      "src/App/" + (index % 2 ? "obj" : "bin") + "/Debug/net10.0/output-" + index + ".dll",
  );
  const sourceText = "authored edit survives aggregate recovery\n";
  await fs.writeFile(path.join(projection, ".gitignore"), ".env.local\n**/bin/\n**/obj/\n");
  for (const relative of artifacts) {
    const file = path.join(projection, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "synthetic build output\n");
    await fs.truncate(file, artifactBytes);
  }
  await fs.writeFile(path.join(projection, "source.txt"), sourceText);
  await fs.writeFile(
    path.join(projection, "src/App/App.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk" />\n',
  );
  await fs.mkdir(path.join(projection, "bin"));
  await fs.writeFile(path.join(projection, "bin/authored-script"), "authored executable\n");
  await fs.writeFile(path.join(projection, "src/App/bin/authored-tool"), "authored project tool\n");
  const failure = await first!.checkpoint().catch((error: unknown) => error);
  first![Symbol.dispose]();
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("805306368 byte limit");
  expect(String(failure)).toContain("openclaw sandbox recover");
  const pending = (await readLocalWorkspaceProjection(owner.worktree.id))!.pending_ref;
  await expect(prepareSandbox()).rejects.toThrow("openclaw sandbox recover");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))!.pending_ref).toBe(pending);
  expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe("original\n");
  const recovery = {
    cfg,
    sessionKey: owner.sessionKey,
    path: artifacts[0]!,
    recoveryId: randomUUID(),
    assertCurrent: owner.assertCurrent,
  };
  await expect(recoverLocalWorkspaceFile({ ...recovery, path: "source.txt" })).rejects.toThrow(
    "already admitted",
  );
  await expect(recoverLocalWorkspaceFile({ ...recovery, path: admitted })).rejects.toThrow(
    "already admitted",
  );
  const recovered = await recoverLocalWorkspaceFile(recovery).catch((error: unknown) => {
    throw new Error("Aggregate file relocation failed", { cause: error });
  });
  expect(recovered.bytes).toBe(artifactBytes);
  await expect(
    recoverLocalWorkspaceFile({ ...recovery, path: artifacts[1]!, recoveryId: randomUUID() }),
  ).rejects.toThrow("no aggregate overflow");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))!.pending_ref).toBe(pending);
  expect(await recoverLocalWorkspaceFile(recovery)).toEqual(recovered);
  await expect(fs.stat(path.join(projection, artifacts[0]!))).rejects.toMatchObject({
    code: "ENOENT",
  });
  using resumed = await prepareSandbox().catch((error: unknown) => {
    throw new Error("Preparation after aggregate relocation failed", { cause: error });
  });
  expect(resumed).toBeDefined();
  expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe(sourceText);
  expect(await fs.readFile(path.join(canonical, "bin/authored-script"), "utf8")).toBe(
    "authored executable\n",
  );
  expect(await fs.readFile(path.join(canonical, admitted), "utf8")).toBe(
    "original admitted input\n",
  );
  expect(await fs.readFile(path.join(canonical, "src/App/bin/authored-tool"), "utf8")).toBe(
    "authored project tool\n",
  );
  for (const relative of artifacts.slice(1)) {
    expect((await fs.stat(path.join(canonical, relative))).size).toBe(artifactBytes);
  }
  expect((await fs.stat(recovered.path)).size).toBe(artifactBytes);
  const originalBytes = Buffer.alloc(artifactBytes);
  originalBytes.write("synthetic build output\n");
  expect((await fs.readFile(recovered.path)).equals(originalBytes)).toBe(true);
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    pending_ref: null,
    pending_target: null,
  });
}

export async function proveAcceptedInventoryRecovery(
  owner: LocalWorkspaceOwner,
  retainedMembership: boolean,
) {
  const canonical = owner.worktree.path;
  const prepare = () => withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const synchronize = () =>
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  const readProjection = () => readLocalWorkspaceProjection(owner.worktree.id);
  const git = (root: string, ...args: string[]) => requireGit(root, args);
  const projection = await prepare();
  const attachmentDirectory = stagedInputDirectory(randomUUID());
  const acceptedFiles = new Map([
    ["media/review/patch.txt", "accepted patch\n"],
    ["media/review/note.txt", "accepted verification\n"],
    ["skills/accepted.txt", "accepted skill\n"],
    [`${attachmentDirectory}/.gitignore`, STAGED_INPUT_GITIGNORE],
    [`${attachmentDirectory}/node_modules/input.txt`, "accepted attachment\n"],
  ]);
  for (const [relative, contents] of acceptedFiles) {
    await fs.mkdir(path.dirname(path.join(projection, relative)), { recursive: true });
    await writeText(projection, relative, contents);
  }
  await fs.mkdir(path.join(projection, "skills/accepted-empty"), { recursive: true });
  await synchronize();
  const saved = (await readProjection())!;
  expect(saved).toMatchObject({
    baseline_json: null,
    checkpoint_json: null,
    pending_ref: null,
    pending_target: null,
    journal_json: null,
  });
  expect(await git(canonical, "ls-files")).not.toContain("media/");
  const original = await withLocalWorkspaceProjection(owner, (state) => state.baselineDocument());
  await closeOpenClawStateDatabaseAsync();
  {
    using db = new DatabaseSync(resolveOpenClawStateSqlitePath());
    const records = decodeLocalWorkspaceTree(readLocalWorkspaceTree(db, saved.tree_root_digest!));
    const child = records.get("media/review")!.children!;
    const missing = records.get(child)!.treeRef;
    expect(
      db
        .prepare("DELETE FROM local_workspace_tree_packs WHERE tree_digest = ?")
        .run(localWorkspaceDigestBytes(missing)).changes,
    ).toBe(1);
  }
  const partial = "media/review/fingerprint.txt";
  await writeText(projection, partial, "partial fingerprint\n");
  if (retainedMembership) {
    await fs.unlink(path.join(projection, "skills/accepted.txt"));
    for (const directory of [canonical, projection]) {
      await fs.mkdir(path.join(directory, "skills/accepted-empty/node_modules"));
      await writeText(directory, "skills/accepted-empty/node_modules/cache.txt", "local cache\n");
    }
  }
  const recovered = await withLocalWorkspaceProjection(owner, (state) => state.baselineDocument());
  expect(recovered).toEqual(original);
  expect(await readProjection()).toMatchObject({
    baseline_ref: saved.baseline_ref,
    tree_root_digest: saved.tree_root_digest,
    source_paths_digest: saved.source_paths_digest,
  });
  await expectMissing(canonical, partial);
  await expectText(projection, partial, "partial fingerprint\n");
  for (const [relative, contents] of acceptedFiles) {
    await expectText(canonical, relative, contents);
    if (retainedMembership && relative === "skills/accepted.txt") {
      await expectMissing(projection, relative);
    } else {
      await expectText(projection, relative, contents);
    }
  }
  await expect(
    withLocalWorkspaceProjection(
      {
        ...owner,
        assertCurrent: () => {
          throw new Error("revoked");
        },
      },
      (state) => state.prepare(),
    ),
  ).rejects.toThrow("revoked");
  await expectMissing(canonical, partial);
  await prepare();
  await expectText(canonical, partial, "partial fingerprint\n");
  await writeText(projection, partial, "completed fingerprint\n");
  await synchronize();
  await expectText(canonical, partial, "completed fingerprint\n");
  if (retainedMembership) {
    await expectMissing(canonical, "skills/accepted.txt");
    expect((await fs.stat(path.join(canonical, "skills/accepted-empty"))).isDirectory()).toBe(true);
  }
  await expectMissing(projection, ".env.local");
}

export async function proveUnsafePathWorkspaceRecovery(
  owner: LocalWorkspaceOwner,
  setRevoked: (value: boolean) => void,
) {
  const canonical = owner.worktree.path;
  const prepare = () => withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const synchronize = () =>
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  const readProjection = () => readLocalWorkspaceProjection(owner.worktree.id);
  const projection = await prepare();
  const rejected = path.join(projection, "legacy\\notes.txt");
  const corrected = path.join(projection, "legacy-notes.txt");
  const accepted = (await readProjection())!;
  await fs.writeFile(rejected, "retained sample\n", { mode: 0o644 });
  await writeText(projection, "report.md", "retained report\n");
  try {
    await expect(synchronize()).rejects.toThrow("manifest contains an unsafe path");
    const pending = (await readProjection())!;
    expect(pending.pending_target).toBe("canonical");
    expect(pending.pending_ref).toBeTruthy();
    const { workerWorkspaceResultStaging: staging } = await import("./workspace-result-staging.js");
    const stage = staging.stageWorkerWorkspaceResult;
    // Keep the real worker rejection, then revoke its caller before delivery.
    const revokedStage = vi
      .spyOn(staging, "stageWorkerWorkspaceResult")
      .mockImplementationOnce(async (params) => {
        try {
          return await stage(params);
        } catch (failure) {
          expect(failure).toHaveProperty("code", "WORKSPACE_STAGE_CURRENT_PATH_UNSAFE");
          setRevoked(true);
          throw failure;
        }
      });
    try {
      await expect(prepare()).rejects.toThrow("revoked");
    } finally {
      setRevoked(false);
      revokedStage.mockRestore();
    }
    await writeText(canonical, "source.txt", "accepted human edit\n");

    expect(await prepare()).toBe(projection);
    expect(await readProjection()).toMatchObject({
      baseline_ref: accepted.baseline_ref,
      pending_ref: pending.pending_ref,
      pending_target: "canonical",
      journal_json: null,
    });
    await expectText(projection, "source.txt", "original\n");
    await expectText(canonical, "source.txt", "accepted human edit\n");
    await expect(synchronize()).rejects.toThrow("manifest contains an unsafe path");
    await expectMissing(canonical, "report.md");
    await expect(
      withLocalWorkspaceProjection({ ...owner, sessionId: randomUUID() }, (state) =>
        state.prepare(),
      ),
    ).rejects.toThrow("different session incarnation");
    setRevoked(true);
    await expect(prepare()).rejects.toThrow("revoked");
    setRevoked(false);

    await fs.rename(rejected, corrected);
    await synchronize();
    await expectText(canonical, "legacy-notes.txt", "retained sample\n");
    await expectText(canonical, "report.md", "retained report\n");
    await expectText(canonical, "source.txt", "accepted human edit\n");
    expect((await fs.stat(corrected)).mode & 0o777).toBe(0o644);
    expect((await readProjection())!.pending_ref).toBeNull();
    await prepare();
    await expectText(projection, "source.txt", "accepted human edit\n");
    await expectText(canonical, "source.txt", "accepted human edit\n");
  } finally {
    setRevoked(false);
    if (existsSync(rejected)) {
      await fs.rename(rejected, corrected);
    }
    await synchronize();
  }
}

export async function proveUnsafePathWorkspaceCollision(owner: LocalWorkspaceOwner) {
  const canonical = owner.worktree.path;
  const prepare = () => withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const synchronize = () =>
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  const readProjection = () => readLocalWorkspaceProjection(owner.worktree.id);
  const projection = await prepare();
  const rejected = path.join(projection, "legacy\\notes.txt");
  const corrected = path.join(projection, "notes.txt");
  await fs.writeFile(rejected, "guest sample\n");
  try {
    await expect(synchronize()).rejects.toThrow("manifest contains an unsafe path");
    await writeText(canonical, "notes.txt", "human sample\n");
    expect(await prepare()).toBe(projection);
    await fs.rename(rejected, corrected);
    await expect(synchronize()).rejects.toThrow("conflict");
    await expect(prepare()).rejects.toThrow("conflict");
    await expectText(canonical, "notes.txt", "human sample\n");
    await expectText(projection, "notes.txt", "guest sample\n");
    expect((await readProjection())!.pending_ref).toBeTruthy();
  } finally {
    if (existsSync(rejected)) {
      await fs.rename(rejected, corrected);
    }
    await fs.rm(path.join(canonical, "notes.txt"), { force: true });
    await synchronize();
  }
}
