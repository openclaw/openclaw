import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { STAGED_INPUT_GITIGNORE, stagedInputDirectory } from "../../media/staged-inputs.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { readActualWorkspaceManifestImpl } from "./workspace-actual-manifest.js";
import { parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import {
  MAX_RECONCILIATION_FILE_BYTES,
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { DERIVED_WORKSPACE_RSYNC_EXCLUDES } from "./workspace-path-exclusions.js";
import {
  createScriptWorkspace,
  initializeScriptGitWorkspace,
  writeWorkspaceFiles,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const fileEntry = (entryPath: string, content: string, size = content.length) => ({
  path: entryPath,
  type: "file" as const,
  mode: 0o644,
  size,
  sha256: digest(content),
});
async function readCapture(manifestRoot: string, ref: string) {
  const { entries }: { entries: Array<{ path: string; type: string }> } = JSON.parse(
    await fs.readFile(path.join(manifestRoot, `${ref.trim().slice(7)}.json`), "utf8"),
  );
  return {
    files: entries.filter((entry) => entry.type !== "directory"),
    directories: entries.filter((entry) => entry.type === "directory").map((entry) => entry.path),
  };
}
const cache = ".cache/vitest/results.json";
const packageCaches = [
  ".local/share/pnpm/store/v11/files/10/package-content",
  ".cache/openclaw/bun/pinned/linux-x64/bin/bun",
  ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
  ".cache/bun-transpiler/compiled.pile",
  ".artifacts/vitest-worker-cache/run-cache-0/outputs/dist/worker.js",
  ".artifacts/vitest-shard-timings.json",
];
const workerPackage = ".artifacts/vitest-workers/run-cache-0/package.json";
const lock = ".artifacts/dist-artifacts.lock/owner.json";
const stagedRoot = stagedInputDirectory("a".repeat(64));
const userFiles = {
  ".gitignore": ".artifacts/\n.cache/\n.local/\n",
  ".local/share/pnpm/store-notes.md": "user notes\n",
  ".local/share/pnpm/tools/tool.js": "user tool\n",
  "fixtures/.local/share/pnpm/store/input.txt": "nested user fixture\n",
  [`${stagedRoot}/.gitignore`]: STAGED_INPUT_GITIGNORE,
  [`${stagedRoot}/.local/share/pnpm/store/input.txt`]: "staged input\n",
  ".artifacts/report.md": "user report\n",
  ".artifacts/build-all-cache/authored.txt": "original input\n",
  ".artifacts/build-cache-inputs/authored.json": "original input\n",
  ".artifacts/vitest-worker-cache-notes.md": "user notes\n",
  ".artifacts/vitest-shard-timings.json-notes": "user notes\n",
  "fixtures/.artifacts/vitest-worker-cache/input.js": "nested user fixture\n",
  ".cache/bun-transpiler-notes.md": "user notes\n",
  "fixtures/.cache/bun-transpiler/input.pile": "nested user fixture\n",
  [`${stagedRoot}/.cache/bun-transpiler/input.pile`]: "staged input\n",
  [`${stagedRoot}/.artifacts/vitest-worker-cache/input.js`]: "staged input\n",
  ".openclaw/tmp/unit.log": "guest log\n",
  ".artifacts/vitest-workers-notes.md": "user notes\n",
  "fixtures/.artifacts/vitest-workers/input.json": "nested user fixture\n",
  ".cache/openclaw/notes.md": "user notes\n",
  ".cache/ms-playwright-notes.md": "user notes\n",
  "fixtures/.cache/ms-playwright/input.txt": "nested user fixture\n",
  ".cache/user-data.json": "user data\n",
  ".cache/vitest-input.txt": "user fixture\n",
  ".artifacts/dist-artifacts.lock-notes": "user notes\n",
  "fixtures/.cache/vitest/input.json": "nested user fixture\n",
};

it("excludes only generated runtime roots from capture and transfer", async () => {
  const { workspace, runManifest, manifestRoot } = await createScriptWorkspace(
    tempDirs.make("workspace-generated-capture-"),
  );
  await writeWorkspaceFiles(workspace, {
    ...userFiles,
    "source.ts": "source edit\n",
    [cache]: "test cache\n",
    ...Object.fromEntries(packageCaches.map((name) => [name, ""])),
    [lock]: "transient owner\n",
    [workerPackage]: '{"type":"module"}\n',
  });
  for (const name of packageCaches) {
    await fs.truncate(path.join(workspace, name), MAX_RECONCILIATION_FILE_BYTES + 1);
  }
  const local = await readActualWorkspaceManifestImpl({ root: workspace, baseCommit: null });
  const result = parseChangedWorkspaceResult(
    { version: 1, baseCommit: null, entries: [] },
    local.manifest,
  );
  expect(result.entries.some((entry) => entry.path === "source.ts")).toBe(true);
  const remote = await runManifest(["", "all"]);
  expect(remote.code, remote.stderr).toBe(0);
  const expected = [...Object.keys(userFiles), "source.ts"].toSorted();
  expect(local.manifest.entries.map((entry) => entry.path).toSorted()).toEqual(expected);
  const captured = await readCapture(manifestRoot, remote.stdout);
  expect(captured.files.map((entry) => entry.path).toSorted()).toEqual(expected);
  expect(captured.directories).toEqual(local.manifest.directories);
  const oversizedArtifact = ".local/share/user-data.bin";
  const oversized = {
    ...local.manifest,
    entries: [fileEntry(oversizedArtifact, "", MAX_RECONCILIATION_FILE_BYTES + 1)],
  };
  expect(() =>
    parseChangedWorkspaceResult({ version: 1, baseCommit: null, entries: [] }, oversized),
  ).toThrow(`Cloud workspace result is too large: ${oversizedArtifact}`);
  if (process.platform !== "win32") {
    const target = tempDirs.make("workspace-generated-transfer-");
    const transfer = await runCommandWithTimeout(
      [
        "rsync",
        "--archive",
        ...DERIVED_WORKSPACE_RSYNC_EXCLUDES.map((entry) => `--exclude=${entry}`),
        `${workspace}/`,
        `${target}/`,
      ],
      { timeoutMs: 10_000 },
    );
    expect(transfer.code, transfer.stderr).toBe(0);
    for (const name of [cache, lock, workerPackage, ...packageCaches]) {
      await expect(fs.stat(path.join(target, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const [name, content] of Object.entries(userFiles)) {
      expect(await fs.readFile(path.join(target, name), "utf8")).toBe(content);
    }
  }
});

it("omits cache-only ancestry from remote capture while retaining empty directories", async () => {
  const { workspace, runManifest, manifestRoot } = await createScriptWorkspace(
    tempDirs.make("workspace-cache-only-capture-"),
  );
  await writeWorkspaceFiles(
    workspace,
    Object.fromEntries([cache, workerPackage, ...packageCaches].map((name) => [name, "cache"])),
  );
  for (const stage of ["caches", "empty directory", "guest report"]) {
    if (stage === "empty directory") {
      await fs.mkdir(path.join(workspace, "empty"));
    }
    if (stage === "guest report") {
      await writeWorkspaceFiles(workspace, { ".artifacts/report.md": "guest evidence" });
    }
    const remote = await runManifest(["", "all"]);
    expect(remote.code, remote.stderr).toBe(0);
    const raw = await readCapture(manifestRoot, remote.stdout);
    const local = await readActualWorkspaceManifestImpl({ root: workspace, baseCommit: null });
    expect(raw.directories).toEqual(local.manifest.directories);
    expect(raw.files).toEqual(local.manifest.entries);
    expect(local.manifest.directories).toEqual(
      stage === "caches" ? [] : stage === "empty directory" ? ["empty"] : [".artifacts", "empty"],
    );
  }
});

it.each([false, true])(
  "projects historical caches for Git capture and lookup (guest report: %s)",
  async (report) => {
    const { workspace, runManifest, manifestRoot } = await createScriptWorkspace(
      tempDirs.make("workspace-legacy-cache-capture-"),
    );
    const cachePath = ".artifacts/vitest-worker-cache/out.js";
    await writeWorkspaceFiles(workspace, {
      ".gitignore": ".artifacts/\nmedia/inbound/\n",
      "source.txt": "source",
      [cachePath]: "cache",
      [`${stagedRoot}/.gitignore`]: STAGED_INPUT_GITIGNORE,
      [`${stagedRoot}/__pycache__/input.pyc`]: "staged input",
      ...(report ? { ".artifacts/report.md": "guest evidence" } : {}),
    });
    await fs.mkdir(path.join(workspace, "kept-empty"));
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".");
    const current = await readActualWorkspaceManifestImpl({ root: workspace, baseCommit });
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
        fileEntry(cachePath, "cache"),
      ].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    });
    const legacyDigest = digest(legacy);
    await fs.mkdir(manifestRoot, { recursive: true });
    const legacyPath = path.join(manifestRoot, `${legacyDigest}.json`);
    await fs.writeFile(legacyPath, legacy);
    const expected = serializeWorkerWorkspaceManifest(
      parseWorkerWorkspaceManifest(legacy, `sha256:${legacyDigest}`),
    );
    const expectedDigest = digest(expected);
    const resolved = await runManifest([baseCommit, "resolve", expectedDigest]);
    expect(resolved.code, resolved.stderr).toBe(0);
    expect(resolved.stdout.trim()).toBe(`sha256:${expectedDigest}`);
    const captured = await runManifest([baseCommit, "eligible", legacyDigest]);
    expect(captured.code, captured.stderr).toBe(0);
    expect(captured.stdout.trim()).toBe(`sha256:${expectedDigest}`);
    expect(await fs.readFile(legacyPath, "utf8")).toBe(legacy);
    expect(await fs.readFile(path.join(manifestRoot, `${expectedDigest}.json`), "utf8")).toBe(
      current.rawManifest,
    );
  },
);
