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
import {
  expectWorkspaceFiles,
  writeWorkspaceFiles,
} from "./workspace-sync-scripts.test-support.js";

const workerPackage = ".artifacts/vitest-workers/run-cache-0/package.json";
const retainedWorker = ".artifacts/vitest-worker-cache/run-cache-0/outputs/dist/worker.js";
const cache = ".cache/vitest/results.json";
const lock = ".artifacts/dist-artifacts.lock/owner.json";
const packageCaches = [
  ".openclaw/tmp/toolchain/node/bin/node",
  ".local/share/pnpm/store/v11/files/10/package-content",
  ".openclaw/.pnpm-store/v11/files/10/package-content",
  ".cache/openclaw/bun/pinned/linux-x64/bin/bun",
  ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
  ".cache/bun-transpiler/compiled.pile",
];
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

export async function proveNestedGitWorkspaceRecovery(owner: LocalWorkspaceOwner, version: 1 | 2) {
  const canonical = owner.worktree.path;
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const row = (await readLocalWorkspaceProjection(owner.worktree.id))!;
  const nested = ".toolchain/uv-cache/sdists-v9";
  const runGit = async (args: string[], input?: Uint8Array) => {
    const result = await runCommandWithTimeout(["git", "-C", canonical, ...args], {
      timeoutMs: 10_000,
      ...(input ? { input } : {}),
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await fs.mkdir(path.join(projection, nested), { recursive: true });
  // Real metadata, not a directory named .git with invented contents.
  await runGit(["init", "--quiet", "--template=", path.join(projection, nested)]);
  const base = { ...(await manifestFor(projection)), baseCommit: row.base_commit };
  const before = legacyManifest(base);
  await setBaseline(owner, before);
  await fs.appendFile(path.join(projection, nested, ".git/config"), "\n# historical cache churn\n");
  await writeWorkspaceFiles(projection, { "source.txt": "pending source edit\n" });
  const current = { ...(await manifestFor(projection)), baseCommit: row.base_commit };
  const after = legacyManifest(current);
  const changed = current.entries.filter(
    (entry) =>
      !sameEntry(
        base.entries.find((previous) => previous.path === entry.path),
        entry,
      ),
  );
  // Synthetic historical storage: Git can retain these objects even though today's
  // fast-import rejects .git components. Use actual Git objects and the real reader.
  const tree = async (entries: typeof current.entries, prefix = ""): Promise<string> => {
    const names = [
      ...new Set(entries.map((entry) => entry.path.slice(prefix.length).split("/")[0]!)),
    ].toSorted();
    const records: Buffer[] = [];
    for (const name of names) {
      const relative = prefix + name;
      const entry = entries.find((candidate) => candidate.path === relative);
      const object = entry
        ? await runGit(
            ["hash-object", "-w", "--stdin"],
            await readWorkspaceGitEntry(projection, entry),
          )
        : await tree(
            entries.filter((candidate) => candidate.path.startsWith(relative + "/")),
            relative + "/",
          );
      const mode = entry ? ((entry.mode & 0o111) !== 0 ? "100755" : "100644") : "40000";
      records.push(Buffer.from(`${mode} ${name}\0`), Buffer.from(object, "hex"));
    }
    return runGit(
      ["hash-object", "--literally", "-w", "-t", "tree", "--stdin"],
      Buffer.concat(records),
    );
  };
  const resultTree = await tree(version === 1 ? current.entries : changed);
  const message = (currentRef: string) =>
    Buffer.from(
      `${STAGED_RESULT_MESSAGE}\nversion ${version}\nbase-ref ${before.ref}\ncurrent-ref ${currentRef}\nbase-bytes ${Buffer.byteLength(before.raw)}\ncurrent-bytes ${Buffer.byteLength(after.raw)}\n\n${before.raw}${after.raw}`,
    );
  const ref = workerWorkspaceResultRef(`historical-nested-git-v${version}`);
  const commit = await runGit(["commit-tree", resultTree], message(after.ref));
  await runGit(["update-ref", ref, commit]);
  expect(await readStagedWorkerWorkspaceResult(canonical, ref)).toMatchObject({
    baseManifestRaw: before.raw,
    baseManifestRef: before.ref,
    currentManifestRaw: after.raw,
    currentManifestRef: after.ref,
  });
  const invalid = workerWorkspaceResultRef(`historical-nested-git-v${version}-bad-digest`);
  await runGit([
    "update-ref",
    invalid,
    await runGit(["commit-tree", resultTree], message(`sha256:${"0".repeat(64)}`)),
  ]);
  await expect(readStagedWorkerWorkspaceResult(canonical, invalid)).rejects.toThrow("digest");
  await runGit(["update-ref", "-d", invalid]);
  await updateProjection(owner, { pending_ref: ref, pending_target: "canonical" });
  const config = path.join(nested, ".git/config");
  const metadata = await fs.readFile(path.join(projection, config));
  await closeOpenClawStateDatabaseAsync();
  await withLocalWorkspaceProjection(owner, (state) => state.settle());
  await expectWorkspaceFiles(canonical, { "source.txt": "pending source edit\n" });
  await missing(canonical, path.join(nested, ".git"));
  expect(await fs.readFile(path.join(projection, config))).toEqual(metadata);
  // The immutable receipt retains its historical bytes, while acceptance owns a
  // new current-policy baseline containing only the independently known source.
  const acceptedBaseline = legacyManifest({
    version: 1,
    baseCommit: row.base_commit,
    entries: [
      workspaceFile(".gitignore", ".env.local\n"),
      workspaceFile("source.txt", "pending source edit\n"),
    ],
  });
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    const accepted = store.get()!;
    expect(accepted.pending_ref).toBeNull();
    expect(await store.manifest(accepted, { kind: "materialize" })).toEqual({
      kind: "materialize",
      rawManifest: acceptedBaseline.raw,
      manifestRef: acceptedBaseline.ref,
    });
  });
  await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  await writeWorkspaceFiles(projection, { "source.txt": "next source edit\n" });
  await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  await expectWorkspaceFiles(canonical, { "source.txt": "next source edit\n" });
  expect(await fs.readFile(path.join(projection, config))).toEqual(metadata);
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
  await expectWorkspaceFiles(owner.worktree.path, { ".env.local": "host-only-secret" });
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
  await writeWorkspaceFiles(projection, {
    [retainedWorker]: "previous compiler output\n",
    ...cacheFiles(packageCaches, "previous dependency cache\n"),
  });
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
    baseline_json: null,
    checkpoint_json: null,
  });
  // The next ordinary turn must parse the accepted byte/digest pair and synchronize both copies.
  await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  for (const directory of [projection, canonical]) {
    await expectWorkspaceFiles(directory, projectFiles);
    for (const name of [lock, workerPackage]) {
      await missing(directory, name);
    }
  }
  await expectWorkspaceFiles(canonical, cacheFiles(caches, "local cache churn\n"));
  await expectWorkspaceFiles(projection, cacheFiles(caches, "guest cache churn\n"));
  await missing(canonical, retainedWorker);
  await expectWorkspaceFiles(projection, { [retainedWorker]: "next compiler output\n" });
  await expectWorkspaceFiles(canonical, { ".env.local": "host-only-secret" });
  await missing(projection, ".env.local");

  await fs.writeFile(path.join(projection, "source.txt"), "next guest edit\n");
  await fs.writeFile(path.join(canonical, "source.txt"), "concurrent human edit\n");
  await expect(
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
  ).rejects.toThrow("conflict");
  await expectWorkspaceFiles(canonical, { "source.txt": "concurrent human edit\n" });
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeTruthy();
  await fs.writeFile(path.join(canonical, "source.txt"), "guest source edit\n");
  await withLocalWorkspaceProjection(owner, (state) => state.settle());
  await expectWorkspaceFiles(canonical, { "source.txt": "next guest edit\n" });

  const scratch = ".openclaw/tmp/toolchain/node/bin/node";
  await fs.truncate(path.join(projection, scratch), 100 * 1024 * 1024);
  await fs.writeFile(path.join(projection, "source.txt"), "edit after toolchain download\n");
  await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  await closeOpenClawStateDatabaseAsync();
  await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  await expectWorkspaceFiles(canonical, {
    "source.txt": "edit after toolchain download\n",
    [scratch]: "local cache churn\n",
  });
  expect((await fs.stat(path.join(projection, scratch))).size).toBe(100 * 1024 * 1024);
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    pending_ref: null,
    pending_target: null,
  });

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
