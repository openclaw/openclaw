import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { STAGED_INPUT_GITIGNORE, stagedInputDirectory } from "../../media/staged-inputs.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { readActualWorkspaceManifestImpl } from "./workspace-actual-manifest.js";
import { sha256 as digest } from "./workspace-manifest-fixtures.test-support.js";
import { MAX_RECONCILIATION_FILE_BYTES } from "./workspace-manifest.js";
import { DERIVED_WORKSPACE_RSYNC_EXCLUDES } from "./workspace-path-exclusions.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";
import {
  createScriptWorkspace,
  initializeScriptGitWorkspace,
  writeWorkspaceFiles,
  workspaceScriptRunner,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cacheEntry = { type: "file" as const, mode: 0o644, size: 5, sha256: digest("cache") };
async function makeWorkspace(files: Record<string, string>) {
  const fixture = await createScriptWorkspace(tempDirs.make("workspace-generated-"));
  await writeWorkspaceFiles(fixture.workspace, files);
  const manifestPath = (ref: string) =>
    path.join(fixture.manifestRoot, `${ref.trim().slice(7)}.json`);
  const readLocal = (baseCommit: string | null = null) =>
    readActualWorkspaceManifestImpl({ root: fixture.workspace, baseCommit });
  const capture = async () => {
    const local = await readLocal();
    const remote = await fixture.runManifest(["", "all"]);
    expect(remote.code, remote.stderr).toBe(0);
    const { entries }: { entries: Array<{ path: string; type: string }> } = JSON.parse(
      await fs.readFile(manifestPath(remote.stdout), "utf8"),
    );
    expect(
      entries.filter((entry) => entry.type === "directory").map((entry) => entry.path),
    ).toEqual(local.manifest.directories);
    return { local, files: entries.filter((entry) => entry.type !== "directory") };
  };
  return { ...fixture, manifestPath, readLocal, capture };
}
const cacheRoots = [
  ".local/share/pnpm/store",
  ".cache/openclaw/bun",
  ".cache/ms-playwright",
  ".cache/bun-transpiler",
  ".artifacts/vitest-worker-cache",
  ".artifacts/vitest-workers",
  ".cache/vitest",
  ".artifacts/dist-artifacts.lock",
];
const generatedPaths = [
  ...cacheRoots.map((root) => `${root}/cache.bin`),
  ".artifacts/vitest-shard-timings.json",
];
const workerPackage = ".artifacts/vitest-workers/run-cache-0/package.json";
const stagedRoot = stagedInputDirectory("a".repeat(64));
const userFiles = {
  ".gitignore": ".artifacts/\n.cache/\n.local/\n",
  ".local/share/pnpm/tools/tool.js": "user tool\n",
  [`${stagedRoot}/.gitignore`]: STAGED_INPUT_GITIGNORE,
  ".artifacts/report.md": "user report\n",
  ".artifacts/build-all-cache/authored.txt": "original input\n",
  ".artifacts/build-cache-inputs/authored.json": "original input\n",
  ".artifacts/vitest-shard-timings.json-notes": "user notes\n",
  ".openclaw/tmp/unit.log": "guest log\n",
  ".cache/openclaw/notes.md": "user notes\n",
  ".cache/user-data.json": "user data\n",
  ...Object.fromEntries(
    cacheRoots.flatMap((root) => [
      [`${root}-notes`, "user notes\n"],
      [`fixtures/${root}/input`, "nested user fixture\n"],
      [`${stagedRoot}/${root}/input`, "staged input\n"],
    ]),
  ),
};

it("excludes only generated runtime roots from capture and transfer", async () => {
  const { workspace, capture } = await makeWorkspace({
    ...userFiles,
    "source.ts": "source edit\n",
    ...Object.fromEntries(generatedPaths.map((name) => [name, ""])),
    [workerPackage]: '{"type":"module"}\n',
  });
  for (const name of generatedPaths) {
    await fs.truncate(path.join(workspace, name), MAX_RECONCILIATION_FILE_BYTES + 1);
  }
  const { local, files } = await capture();
  const expected = [...Object.keys(userFiles), "source.ts"].toSorted();
  for (const entries of [local.manifest.entries, files]) {
    expect(entries.map((entry) => entry.path).toSorted()).toEqual(expected);
  }
  if (process.platform !== "win32") {
    const target = tempDirs.make("workspace-generated-transfer-");
    const argv = [
      "rsync",
      "--archive",
      ...DERIVED_WORKSPACE_RSYNC_EXCLUDES.map((entry) => `--exclude=${entry}`),
    ];
    const transfer = await runCommandWithTimeout([...argv, `${workspace}/`, `${target}/`], {
      timeoutMs: 10_000,
    });
    expect(transfer.code, transfer.stderr).toBe(0);
    for (const name of [...generatedPaths, workerPackage]) {
      await expect(fs.stat(path.join(target, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const [name, content] of Object.entries(userFiles)) {
      expect(await fs.readFile(path.join(target, name), "utf8")).toBe(content);
    }
  }
});

it("omits cache-only ancestry from remote capture while retaining empty directories", async () => {
  const { workspace, capture } = await makeWorkspace(
    Object.fromEntries([...generatedPaths, workerPackage].map((name) => [name, "cache"])),
  );
  for (const stage of ["caches", "empty directory", "guest report"]) {
    if (stage === "empty directory") {
      await fs.mkdir(path.join(workspace, "empty"));
    }
    if (stage === "guest report") {
      await writeWorkspaceFiles(workspace, { ".artifacts/report.md": "guest evidence" });
    }
    const { local, files } = await capture();
    expect(files).toEqual(local.manifest.entries);
    expect(local.manifest.directories).toEqual(
      stage === "caches" ? [] : stage === "empty directory" ? ["empty"] : [".artifacts", "empty"],
    );
  }
});

it.each([false, true])("projects historical cache receipts (report: %s)", async (report) => {
  const cachePath = ".artifacts/vitest-worker-cache/out.js";
  const { workspace, runManifest, manifestRoot, manifestPath, readLocal } = await makeWorkspace({
    ".gitignore": ".artifacts/\nmedia/inbound/\n",
    "source.txt": "source",
    [cachePath]: "cache",
    [`${stagedRoot}/.gitignore`]: STAGED_INPUT_GITIGNORE,
    [`${stagedRoot}/__pycache__/input.pyc`]: "staged input",
    ...(report ? { ".artifacts/report.md": "guest evidence" } : {}),
  });
  await fs.mkdir(path.join(workspace, "kept-empty"));
  const baseCommit = await initializeScriptGitWorkspace(workspace, ".");
  const current = await readLocal(baseCommit);
  const directories = new Set([
    ...(current.manifest.directories ?? []),
    ".artifacts",
    ".artifacts/vitest-worker-cache",
  ]);
  const legacy = JSON.stringify({
    version: 1,
    baseCommit,
    entries: [
      ...[...directories].map((name) => ({ path: name, type: "directory", mode: 0o700 })),
      ...current.manifest.entries,
      { ...cacheEntry, path: cachePath },
    ].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  });
  const legacyDigest = digest(legacy);
  await fs.mkdir(manifestRoot, { recursive: true });
  const legacyPath = manifestPath(`sha256:${legacyDigest}`);
  await fs.writeFile(legacyPath, legacy);
  const expectedDigest = current.manifestRef.slice(7);
  for (const [mode, ref] of [
    ["resolve", expectedDigest],
    ["eligible", legacyDigest],
  ] as const) {
    const result = await runManifest([baseCommit, mode, ref]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`sha256:${expectedDigest}`);
  }
  expect(await fs.readFile(legacyPath, "utf8")).toBe(legacy);
  expect(await fs.readFile(manifestPath(`sha256:${expectedDigest}`), "utf8")).toBe(
    current.rawManifest,
  );
});

it("retains build-cache inputs staged after the requested base", async () => {
  const { workspace, readManifest, runManifest } = await createScriptWorkspace(
    tempDirs.make("workspace-staged-cache-input-"),
  );
  const authored = ".artifacts/build-all-cache/newly-staged.txt";
  await writeWorkspaceFiles(workspace, { "source.txt": "source" });
  const baseCommit = await initializeScriptGitWorkspace(workspace, ".");
  await writeWorkspaceFiles(workspace, { [authored]: "authored after base" });
  const staged = await runCommandWithTimeout(
    ["git", "-C", workspace, "add", "--force", "--", authored],
    { timeoutMs: 10_000 },
  );
  expect(staged.code, staged.stderr).toBe(0);

  const captured = await runManifest([baseCommit, "all"]);
  expect(captured.code, captured.stderr).toBe(0);
  const manifest = await readManifest(captured.stdout.trim());
  expect(manifest.entries.some((entry) => entry.path === authored)).toBe(true);
});

it("retains admitted plain-workspace cache inputs when Git metadata appears", async () => {
  const { workspace, readManifest, runManifest } = await createScriptWorkspace(
    tempDirs.make("workspace-plain-admission-"),
  );
  const authored = ".artifacts/build-all-cache/authored.txt";
  const selected = ".artifacts/build-all-cache/compiler-input.json";
  const generated = ".artifacts/build-all-cache/generated/output.js";
  await writeWorkspaceFiles(workspace, {
    ".gitignore": ".artifacts/build-all-cache/\n",
    ".worktreeinclude": `${selected}\n`,
    "source.txt": "source\n",
    [authored]: "authored before Git\n",
  });

  const plain = await runManifest(["", "all"]);
  expect(plain.code, plain.stderr).toBe(0);
  const plainRef = plain.stdout.trim();
  expect((await readManifest(plainRef)).entries.some((entry) => entry.path === authored)).toBe(
    true,
  );

  const initialized = await runCommandWithTimeout(["git", "-C", workspace, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(initialized.code, initialized.stderr).toBe(0);
  await writeWorkspaceFiles(workspace, {
    [selected]: "selected after Git\n",
    [generated]: "disposable cache\n",
  });

  const captured = await runManifest(["", "all", plainRef.slice(7)]);
  expect(captured.code, captured.stderr).toBe(0);
  const manifest = await readManifest(captured.stdout.trim());
  expect(manifest.entries.some((entry) => entry.path === authored)).toBe(true);
  expect(manifest.entries.some((entry) => entry.path === selected)).toBe(true);
  expect(manifest.entries.some((entry) => entry.path === generated)).toBe(false);
  expect(manifest.entries.some((entry) => entry.path === "source.txt")).toBe(true);
});

it("retains host-admitted cache inputs after an initial base-only worker setup", async () => {
  const { root, env, workspace, readManifest } = await createScriptWorkspace(
    tempDirs.make("workspace-initial-ssh-admission-"),
  );
  const authored = ".artifacts/build-all-cache/newly-staged.txt";
  const generated = ".artifacts/build-all-cache/generated/output.js";
  await writeWorkspaceFiles(workspace, { "source.txt": "source\n" });
  const baseCommit = await initializeScriptGitWorkspace(workspace, ".");
  // The host admits the cache input without committing it.
  await writeWorkspaceFiles(workspace, { [authored]: "host staged\n" });
  const staged = await runCommandWithTimeout(
    ["git", "-C", workspace, "add", "--force", "--", authored],
    { timeoutMs: 10_000 },
  );
  expect(staged.code, staged.stderr).toBe(0);

  // The SSH setup script rebuilds the worker index from the base commit, then
  // rsync copies the uncommitted admission into the worker worktree.
  const worker = path.join(root, "worker");
  const cloned = await runCommandWithTimeout(
    ["git", "clone", "--quiet", "--no-hardlinks", "--", workspace, worker],
    { timeoutMs: 10_000 },
  );
  expect(cloned.code, cloned.stderr).toBe(0);
  await writeWorkspaceFiles(worker, { [authored]: "host staged\n", [generated]: "cache\n" });

  const runWorkerManifest = workspaceScriptRunner(REMOTE_WORKSPACE_MANIFEST_JS, worker, env);
  const withoutAdmission = await runWorkerManifest([baseCommit, "eligible"]);
  expect(withoutAdmission.code, withoutAdmission.stderr).toBe(0);
  const dropped = await readManifest(withoutAdmission.stdout.trim());
  expect(dropped.entries.some((entry) => entry.path === authored)).toBe(false);

  const captured = await runWorkerManifest([baseCommit, "eligible", "retained-v1"], {
    input: JSON.stringify({ admittedInputs: [authored] }),
  });
  expect(captured.code, captured.stderr).toBe(0);
  const manifest = await readManifest(captured.stdout.trim());
  expect(manifest.entries.some((entry) => entry.path === authored)).toBe(true);
  expect(manifest.entries.some((entry) => entry.path === generated)).toBe(false);
  expect(manifest.entries.some((entry) => entry.path === "source.txt")).toBe(true);
});

it("retains new cache inputs selected by worktreeinclude after the base", async () => {
  const { workspace, readManifest, runManifest } = await createScriptWorkspace(
    tempDirs.make("workspace-include-admission-"),
  );
  const selected = ".artifacts/build-cache-inputs/compiler-input.json";
  const generated = ".artifacts/build-cache-inputs/generated/output.js";
  await writeWorkspaceFiles(workspace, {
    ".gitignore": ".artifacts/build-cache-inputs/\n",
    ".worktreeinclude": `${selected}\n`,
    "source.txt": "source\n",
  });
  const baseCommit = await initializeScriptGitWorkspace(workspace, ".");
  const initial = await runManifest([baseCommit, "eligible"]);
  expect(initial.code, initial.stderr).toBe(0);

  // The worker creates a new cache-root input after the base; it is ignored by
  // Git but explicitly selected by .worktreeinclude.
  await writeWorkspaceFiles(workspace, {
    [selected]: "worker compiler input\n",
    [generated]: "disposable cache\n",
  });
  const captured = await runManifest([baseCommit, "eligible", initial.stdout.trim().slice(7)]);
  expect(captured.code, captured.stderr).toBe(0);
  const manifest = await readManifest(captured.stdout.trim());
  expect(manifest.entries.some((entry) => entry.path === selected)).toBe(true);
  expect(manifest.entries.some((entry) => entry.path === generated)).toBe(false);
});
