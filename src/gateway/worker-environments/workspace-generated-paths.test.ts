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
import {
  createScriptWorkspace,
  initializeScriptGitWorkspace,
  writeWorkspaceFiles,
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
  ".openclaw/tmp",
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
  ".openclaw/project.json": "project data\n",
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
