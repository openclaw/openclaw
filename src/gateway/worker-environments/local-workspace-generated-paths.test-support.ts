import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { readWorkspaceGitEntry, writeWorkspaceGitInput } from "./workspace-git-input.js";
import { sameEntry } from "./workspace-manifest-comparison.js";
import { workspaceFile } from "./workspace-manifest-fixtures.test-support.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";
import { manifestFor } from "./workspace-recovery.test-support.js";
import { STAGED_RESULT_MESSAGE } from "./workspace-result-inventory.js";
import {
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";
import { writeWorkspaceFiles } from "./workspace-sync-scripts.test-support.js";

function legacyManifest(manifest: WorkerWorkspaceManifest) {
  // Preserve historical generated entries, independently of today's serializer.
  const entries = [
    ...(manifest.directories ?? []).map((name) => ({ path: name, type: "directory", mode: 0o700 })),
    ...manifest.entries,
  ].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const raw = JSON.stringify({ version: 1, baseCommit: manifest.baseCommit, entries });
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

export async function proveGeneratedWorkspaceExpiry(owner: LocalWorkspaceOwner) {
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  await writeWorkspaceFiles(projection, {
    ".cache/vitest/results.json": "old cache",
    ".artifacts/dist-artifacts.lock/owner.json": "old owner",
  });
  const row = (await readLocalWorkspaceProjection(owner.worktree.id))!;
  const legacy = legacyManifest({
    ...(await manifestFor(projection)),
    baseCommit: row.base_commit,
  });
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    await store.update(store.get()!, { baseline_json: legacy.raw, baseline_ref: legacy.ref });
  });
  await closeOpenClawStateDatabaseAsync();
  await fs.writeFile(path.join(projection, ".cache/vitest/results.json"), "new cache");
  await fs.rm(path.join(projection, ".artifacts/dist-artifacts.lock"), { recursive: true });
  await fs.writeFile(path.join(projection, "source.txt"), "unaccepted source");
  await expect(withLocalWorkspaceProjection(owner, (state) => state.expire())).rejects.toThrow(
    "unaccepted edits",
  );
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toBeDefined();
  await fs.writeFile(path.join(projection, "source.txt"), "original\n");
  await withLocalWorkspaceProjection(owner, (state) => state.expire());
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toBeUndefined();
  await expect(fs.stat(projection)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(owner.worktree.path, ".env.local"), "utf8")).toBe(
    "host-only-secret",
  );
}

export async function proveGeneratedWorkspaceRecovery(owner: LocalWorkspaceOwner, copied: boolean) {
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const cache = ".cache/vitest/results.json";
  const lock = ".artifacts/dist-artifacts.lock/owner.json";
  const projectFiles = {
    ".gitignore": ".env.local\n.artifacts/\n.cache/\n",
    "source.txt": "guest source edit\n",
    ".artifacts/report.md": "guest report\n",
    ".cache/user-data.json": "user data\n",
  };
  if (copied) {
    await writeWorkspaceFiles(projection, projectFiles);
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  }
  const row = (await readLocalWorkspaceProjection(owner.worktree.id))!;
  const base = { ...(await manifestFor(projection)), baseCommit: row.base_commit };
  const files = {
    ...projectFiles,
    [cache]: "captured cache\n",
    [lock]: "departed owner\n",
  };
  await writeWorkspaceFiles(projection, files);
  const current = { ...(await manifestFor(projection)), baseCommit: row.base_commit };
  const before = { raw: row.baseline_json!, ref: row.baseline_ref! };
  const after = legacyManifest(current);
  const ref = workerWorkspaceResultRef("legacy-generated-files");
  const message = Buffer.from(
    `${STAGED_RESULT_MESSAGE}\nversion 2\nbase-ref ${before.ref}\ncurrent-ref ${after.ref}\nbase-bytes ${Buffer.byteLength(before.raw)}\ncurrent-bytes ${Buffer.byteLength(after.raw)}\n\n${before.raw}${after.raw}`,
  );
  const baseEntries = new Map(base.entries.map((entry) => [entry.path, entry]));
  const changed = current.entries.filter((entry) => !sameEntry(baseEntries.get(entry.path), entry));
  const inputPath = path.join(path.dirname(owner.worktree.path), "legacy-result-input");
  await writeWorkspaceGitInput({
    inputPath,
    ref,
    entries: changed,
    readVerifiedContent: (entry) => readWorkspaceGitEntry(projection, entry),
    message: { chunks: [message], byteLength: message.length },
  });
  const imported = await runCommandWithTimeout(
    ["git", "-C", owner.worktree.path, "fast-import", "--quiet"],
    {
      timeoutMs: 10_000,
      input: await fs.readFile(inputPath),
    },
  );
  expect(imported.code, imported.stderr).toBe(0);
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    await store.update(store.get()!, {
      pending_ref: ref,
      pending_target: "canonical",
    });
  });
  await writeWorkspaceFiles(owner.worktree.path, { [cache]: "local cache churn\n" });
  await fs.rm(path.join(owner.worktree.path, lock), { force: true });
  await fs.rm(path.join(projection, lock));
  await fs.writeFile(path.join(projection, cache), "guest cache churn\n");
  await closeOpenClawStateDatabaseAsync();

  await withLocalWorkspaceProjection(owner, (state) => state.settle());
  const accepted = (await readLocalWorkspaceProjection(owner.worktree.id))!;
  expect(accepted.pending_ref).toBeNull();
  expect(accepted.baseline_json).toBe(after.raw);
  expect(accepted.baseline_ref).toBe(after.ref);
  // The next ordinary turn must parse the accepted byte/digest pair and synchronize both copies.
  await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  for (const directory of [projection, owner.worktree.path]) {
    for (const [name, content] of Object.entries(projectFiles)) {
      expect(await fs.readFile(path.join(directory, name), "utf8")).toBe(content);
    }
    await expect(fs.stat(path.join(directory, lock))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await fs.readFile(path.join(owner.worktree.path, cache), "utf8")).toBe(
    "local cache churn\n",
  );
  expect(await fs.readFile(path.join(projection, cache), "utf8")).toBe("guest cache churn\n");
  expect(await fs.readFile(path.join(owner.worktree.path, ".env.local"), "utf8")).toBe(
    "host-only-secret",
  );
  await expect(fs.stat(path.join(projection, ".env.local"))).rejects.toMatchObject({
    code: "ENOENT",
  });

  await fs.writeFile(path.join(projection, "source.txt"), "next guest edit\n");
  await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "concurrent human edit\n");
  await expect(
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
  ).rejects.toThrow("conflict");
  expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
    "concurrent human edit\n",
  );
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeTruthy();
  await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "guest source edit\n");
  await withLocalWorkspaceProjection(owner, (state) => state.settle());
  expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
    "next guest edit\n",
  );

  if (!copied) {
    const invalidRef = workerWorkspaceResultRef("unexpected-artifact");
    const unexpected = workspaceFile(".artifacts/unmanifested.md", "unexpected");
    const invalidInput = inputPath + "-invalid";
    const originalBytes = new Map(Object.entries(files));
    await writeWorkspaceGitInput({
      inputPath: invalidInput,
      ref: invalidRef,
      entries: [...changed, unexpected],
      readVerifiedContent: async (entry) =>
        Buffer.from(entry.path === unexpected.path ? "unexpected" : originalBytes.get(entry.path)!),
      message: { chunks: [message], byteLength: message.length },
    });
    const invalid = await runCommandWithTimeout(
      ["git", "-C", owner.worktree.path, "fast-import", "--quiet"],
      {
        timeoutMs: 10_000,
        input: await fs.readFile(invalidInput),
      },
    );
    expect(invalid.code, invalid.stderr).toBe(0);
    await expect(readStagedWorkerWorkspaceResult(owner.worktree.path, invalidRef)).rejects.toThrow(
      "tree does not match its manifest",
    );
  }
}
