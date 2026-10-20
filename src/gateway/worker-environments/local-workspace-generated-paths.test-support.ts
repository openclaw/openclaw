import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { withLocalWorkspaceStore, type LocalWorkspaceStore } from "./local-workspace-store.js";
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

const workerPackage = ".artifacts/vitest-workers/run-cache-0/package.json";
const retainedWorker = ".artifacts/vitest-worker-cache/run-cache-0/outputs/dist/worker.js";
const cache = ".cache/vitest/results.json";
const lock = ".artifacts/dist-artifacts.lock/owner.json";
const packageCaches = [
  ".local/share/pnpm/store/v11/files/10/package-content",
  ".cache/openclaw/bun/pinned/linux-x64/bin/bun",
  ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
  ".cache/bun-transpiler/compiled.pile",
];
const contents = (directory: string, name: string) =>
  fs.readFile(path.join(directory, name), "utf8");
const missing = (directory: string, name: string) =>
  expect(fs.stat(path.join(directory, name))).rejects.toMatchObject({ code: "ENOENT" });
const cacheFiles = (names: string[], content: string) =>
  Object.fromEntries(names.map((name) => [name, content]));
const updateProjection = (
  owner: LocalWorkspaceOwner,
  patch: Parameters<LocalWorkspaceStore["update"]>[1],
) =>
  withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, (store) =>
    store.update(store.get()!, patch),
  );
const setBaseline = (owner: LocalWorkspaceOwner, snapshot: ReturnType<typeof legacyManifest>) =>
  updateProjection(owner, { baseline_json: snapshot.raw, baseline_ref: snapshot.ref });
async function importResult(owner: LocalWorkspaceOwner, inputPath: string) {
  const result = await runCommandWithTimeout(
    ["git", "-C", owner.worktree.path, "fast-import", "--quiet"],
    { timeoutMs: 10_000, input: await fs.readFile(inputPath) },
  );
  expect(result.code, result.stderr).toBe(0);
}

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
    [cache]: "old cache",
    ...cacheFiles(packageCaches, "old cache"),
    [lock]: "old owner",
    [workerPackage]: '{"type":"module"}\n',
  });
  const row = (await readLocalWorkspaceProjection(owner.worktree.id))!;
  await setBaseline(
    owner,
    legacyManifest({ ...(await manifestFor(projection)), baseCommit: row.base_commit }),
  );
  await closeOpenClawStateDatabaseAsync();
  await fs.writeFile(path.join(projection, cache), "new cache");
  await writeWorkspaceFiles(projection, cacheFiles(packageCaches, "new cache"));
  await fs.rm(path.join(projection, ".artifacts/dist-artifacts.lock"), { recursive: true });
  await fs.rm(path.join(projection, ".artifacts/vitest-workers"), { recursive: true });
  await fs.writeFile(path.join(projection, "source.txt"), "unaccepted source");
  await expect(withLocalWorkspaceProjection(owner, (state) => state.expire())).rejects.toThrow(
    "unaccepted edits",
  );
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toBeDefined();
  await fs.writeFile(path.join(projection, "source.txt"), "original\n");
  // Removing the cache children leaves a real empty directory; expiry preserves it too.
  await expect(withLocalWorkspaceProjection(owner, (state) => state.expire())).rejects.toThrow(
    "unaccepted edits",
  );
  await fs.rmdir(path.join(projection, ".artifacts"));
  await withLocalWorkspaceProjection(owner, (state) => state.expire());
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toBeUndefined();
  await expect(fs.stat(projection)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await contents(owner.worktree.path, ".env.local")).toBe("host-only-secret");
}

export async function proveGeneratedWorkspaceRecovery(owner: LocalWorkspaceOwner, copied: boolean) {
  const canonical = owner.worktree.path;
  const generatedCaches = [
    ...packageCaches,
    ".artifacts/build-all-cache/compile/outputs/dist/output.js",
    ".artifacts/build-cache-inputs/compile.json",
  ];
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const projectFiles = {
    ".gitignore": ".env.local\n.artifacts/\n.cache/\n.local/\n",
    "source.txt": "guest source edit\n",
    ".artifacts/report.md": "guest report\n",
    ".artifacts/build-all-cache-notes.md": "guest notes\n",
    ".artifacts/build-cache-inputs-notes.md": "guest notes\n",
    "fixtures/.artifacts/build-all-cache/input.js": "nested fixture\n",
    "fixtures/.artifacts/build-cache-inputs/input.json": "nested fixture\n",
    ".artifacts/vitest-workers-notes.md": "guest notes\n",
    ".cache/user-data.json": "user data\n",
    ".local/share/user-data.json": "user data\n",
  };
  if (copied) {
    await writeWorkspaceFiles(projection, projectFiles);
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  }
  const row = (await readLocalWorkspaceProjection(owner.worktree.id))!;
  // Old captures can retain a cache ancestor that has since disappeared on the host.
  await writeWorkspaceFiles(projection, { [retainedWorker]: "previous compiler output\n" });
  const base = { ...(await manifestFor(projection)), baseCommit: row.base_commit };
  const before = legacyManifest(base);
  await setBaseline(owner, before);
  const files = {
    ...projectFiles,
    [cache]: "captured cache\n",
    ...cacheFiles(generatedCaches, "captured cache\n"),
    [lock]: "departed owner\n",
    [workerPackage]: '{"type":"module"}\n',
    [retainedWorker]: "next compiler output\n",
  };
  await writeWorkspaceFiles(projection, files);
  const current = { ...(await manifestFor(projection)), baseCommit: row.base_commit };
  const after = legacyManifest(current);
  const ref = workerWorkspaceResultRef("legacy-generated-files");
  const message = Buffer.from(
    `${STAGED_RESULT_MESSAGE}\nversion 2\nbase-ref ${before.ref}\ncurrent-ref ${after.ref}\nbase-bytes ${Buffer.byteLength(before.raw)}\ncurrent-bytes ${Buffer.byteLength(after.raw)}\n\n${before.raw}${after.raw}`,
  );
  const baseEntries = new Map(base.entries.map((entry) => [entry.path, entry]));
  const changed = current.entries.filter((entry) => !sameEntry(baseEntries.get(entry.path), entry));
  const inputPath = path.join(path.dirname(canonical), "legacy-result-input");
  await writeWorkspaceGitInput({
    inputPath,
    ref,
    entries: changed,
    readVerifiedContent: (entry) => readWorkspaceGitEntry(projection, entry),
    message: { chunks: [message], byteLength: message.length },
  });
  await importResult(owner, inputPath);
  await updateProjection(owner, { pending_ref: ref, pending_target: "canonical" });
  const caches = [cache, ...generatedCaches];
  await writeWorkspaceFiles(canonical, cacheFiles(caches, "local cache churn\n"));
  await fs.rm(path.join(canonical, lock), { force: true });
  await fs.rm(path.join(projection, lock));
  await fs.rm(path.join(projection, ".artifacts/vitest-workers"), { recursive: true });
  await writeWorkspaceFiles(projection, cacheFiles(caches, "guest cache churn\n"));
  await closeOpenClawStateDatabaseAsync();

  await missing(canonical, ".artifacts/vitest-worker-cache");
  await withLocalWorkspaceProjection(owner, (state) => state.settle());
  const accepted = (await readLocalWorkspaceProjection(owner.worktree.id))!;
  expect(accepted).toMatchObject({
    pending_ref: null,
    baseline_json: after.raw,
    baseline_ref: after.ref,
  });
  // The next ordinary turn must parse the accepted byte/digest pair and synchronize both copies.
  await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  for (const directory of [projection, canonical]) {
    for (const [name, content] of Object.entries(projectFiles)) {
      expect(await contents(directory, name)).toBe(content);
    }
    for (const name of [lock, workerPackage]) {
      await missing(directory, name);
    }
  }
  for (const name of caches) {
    expect(await contents(canonical, name)).toBe("local cache churn\n");
    expect(await contents(projection, name)).toBe("guest cache churn\n");
  }
  await missing(canonical, retainedWorker);
  expect(await contents(projection, retainedWorker)).toBe("next compiler output\n");
  expect(await contents(canonical, ".env.local")).toBe("host-only-secret");
  await missing(projection, ".env.local");

  await fs.writeFile(path.join(projection, "source.txt"), "next guest edit\n");
  await fs.writeFile(path.join(canonical, "source.txt"), "concurrent human edit\n");
  await expect(
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
  ).rejects.toThrow("conflict");
  expect(await contents(canonical, "source.txt")).toBe("concurrent human edit\n");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeTruthy();
  await fs.writeFile(path.join(canonical, "source.txt"), "guest source edit\n");
  await withLocalWorkspaceProjection(owner, (state) => state.settle());
  expect(await contents(canonical, "source.txt")).toBe("next guest edit\n");

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
    await importResult(owner, invalidInput);
    await expect(readStagedWorkerWorkspaceResult(canonical, invalidRef)).rejects.toThrow(
      "tree does not match its manifest",
    );
  }
}
