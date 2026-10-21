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
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";
import {
  createScriptWorkspace,
  initializeScriptGitWorkspace,
  writeWorkspaceFiles,
  workspaceScriptRunner,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cache = ".cache/vitest/results.json";
const packageCaches = [
  ".local/share/pnpm/store/v11/files/10/package-content",
  ".cache/openclaw/bun/pinned/linux-x64/bin/bun",
  ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
  ".cache/bun-transpiler/compiled.pile",
  ".artifacts/vitest-worker-cache/run-cache-0/outputs/dist/worker.js",
  ".artifacts/vitest-shard-timings.json",
  ".artifacts/build-all-cache/compile/outputs/dist/output.js",
  ".artifacts/build-cache-inputs/compile.json",
];
const workerPackage = ".artifacts/vitest-workers/run-cache-0/package.json";
const lock = ".artifacts/dist-artifacts.lock/owner.json";
const stagedRoot = stagedInputDirectory("a".repeat(64));
const authoredBuildCacheInputs = [
  ".artifacts/build-all-cache/authored.txt",
  ".artifacts/build-cache-inputs/authored.json",
];
const userFiles = {
  ".gitignore": ".artifacts/\n.cache/\n.local/\n",
  ".local/share/pnpm/store-notes.md": "user notes\n",
  ".local/share/pnpm/tools/tool.js": "user tool\n",
  "fixtures/.local/share/pnpm/store/input.txt": "nested user fixture\n",
  [`${stagedRoot}/.gitignore`]: STAGED_INPUT_GITIGNORE,
  [`${stagedRoot}/.local/share/pnpm/store/input.txt`]: "staged input\n",
  ".artifacts/report.md": "user report\n",
  [authoredBuildCacheInputs[0]!]: "original input\n",
  [authoredBuildCacheInputs[1]!]: "original input\n",
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
  const { home, workspace, env } = await createScriptWorkspace(
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
  const initialized = await runCommandWithTimeout(["git", "-C", workspace, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(initialized.code, initialized.stderr).toBe(0);
  const tracked = await runCommandWithTimeout(
    ["git", "-C", workspace, "add", "--force", "--", ...authoredBuildCacheInputs],
    { timeoutMs: 10_000 },
  );
  expect(tracked.code, tracked.stderr).toBe(0);
  const local = await readActualWorkspaceManifestImpl({
    root: workspace,
    baseCommit: null,
    buildCacheInputs: new Set(authoredBuildCacheInputs),
  });
  const result = parseChangedWorkspaceResult(
    { version: 1, baseCommit: null, entries: [] },
    local.manifest,
  );
  expect(result.entries.some((entry) => entry.path === "source.ts")).toBe(true);
  const run = workspaceScriptRunner(REMOTE_WORKSPACE_MANIFEST_JS, workspace, env);
  const remote = await run(["", "all"]);
  expect(remote.code, remote.stderr).toBe(0);
  const raw = await fs.readFile(
    path.join(home, ".openclaw-worker/manifests", `${remote.stdout.trim().slice(7)}.json`),
    "utf8",
  );
  const expected = [...Object.keys(userFiles), "source.ts"].toSorted();
  expect(local.manifest.entries.map((entry) => entry.path).toSorted()).toEqual(expected);
  const captured: { entries: Array<{ path: string; type: string }> } = JSON.parse(raw);
  expect(
    captured.entries
      .filter((entry) => entry.type !== "directory")
      .map((entry) => entry.path)
      .toSorted(),
  ).toEqual(expected);
  expect(
    captured.entries.filter((entry) => entry.type === "directory").map((entry) => entry.path),
  ).toEqual(local.manifest.directories);
  const oversizedArtifact = ".local/share/user-data.bin";
  const oversized = {
    ...local.manifest,
    entries: [
      {
        path: oversizedArtifact,
        type: "file" as const,
        mode: 0o644,
        size: MAX_RECONCILIATION_FILE_BYTES + 1,
        sha256: "0".repeat(64),
      },
    ],
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
    const globallyDerivedCaches = packageCaches.filter(
      (name) => !name.startsWith(".artifacts/build-"),
    );
    for (const name of [cache, lock, workerPackage, ...globallyDerivedCaches]) {
      await expect(fs.stat(path.join(target, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const [name, content] of Object.entries(userFiles)) {
      expect(await fs.readFile(path.join(target, name), "utf8")).toBe(content);
    }
  }
});

it.skipIf(process.platform === "win32")(
  "excludes unreadable exact build-cache roots without hiding useful artifacts",
  async () => {
    const { workspace, runManifest, manifestRoot } = await createScriptWorkspace(
      tempDirs.make("workspace-unreadable-build-caches-"),
    );
    const initialized = await runCommandWithTimeout(["git", "-C", workspace, "init", "--quiet"], {
      timeoutMs: 10_000,
    });
    expect(initialized.code, initialized.stderr).toBe(0);
    const buildCaches = [
      ".artifacts/build-all-cache/compile/outputs/dist/output.js",
      ".artifacts/build-cache-inputs/compile.json",
    ];
    const useful = {
      ".artifacts/report.md": "useful report\n",
      "fixtures/.artifacts/build-all-cache/input.js": "nested fixture\n",
      "fixtures/.artifacts/build-cache-inputs/input.json": "nested fixture\n",
      "source.ts": "source\n",
    };
    await writeWorkspaceFiles(workspace, {
      ...useful,
      ...Object.fromEntries(buildCaches.map((name) => [name, "disposable cache\n"])),
    });
    for (const name of buildCaches) {
      await fs.chmod(path.join(workspace, name), 0);
    }
    try {
      const local = await readActualWorkspaceManifestImpl({
        root: workspace,
        baseCommit: null,
        buildCacheInputs: new Set(),
      });
      expect(local.manifest.entries.map((entry) => entry.path).toSorted()).toEqual(
        Object.keys(useful).toSorted(),
      );
      const remote = await runManifest(["", "all"]);
      expect(remote.code, remote.stderr).toBe(0);
      const captured = JSON.parse(
        await fs.readFile(path.join(manifestRoot, `${remote.stdout.trim().slice(7)}.json`), "utf8"),
      ) as { entries: Array<{ path: string; type: string }> };
      expect(
        captured.entries
          .filter((entry) => entry.type !== "directory")
          .map((entry) => entry.path)
          .toSorted(),
      ).toEqual(Object.keys(useful).toSorted());

      await fs.chmod(path.join(workspace, ".artifacts/report.md"), 0);
      await expect(
        readActualWorkspaceManifestImpl({
          root: workspace,
          baseCommit: null,
          buildCacheInputs: new Set(),
        }),
      ).rejects.toThrow("EACCES");
      const failed = await runManifest(["", "all"]);
      expect(failed.code).not.toBe(0);
      expect(failed.stderr).toContain("EACCES");
    } finally {
      for (const name of [...buildCaches, ".artifacts/report.md"]) {
        await fs.chmod(path.join(workspace, name), 0o644);
      }
    }
  },
);

it("omits cache-only ancestry from remote capture while retaining empty directories", async () => {
  const { workspace, runManifest, manifestRoot } = await createScriptWorkspace(
    tempDirs.make("workspace-cache-only-capture-"),
  );
  const initialized = await runCommandWithTimeout(["git", "-C", workspace, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(initialized.code, initialized.stderr).toBe(0);
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
    const raw: { entries: Array<{ path: string; type: string }> } = JSON.parse(
      await fs.readFile(path.join(manifestRoot, `${remote.stdout.trim().slice(7)}.json`), "utf8"),
    );
    const local = await readActualWorkspaceManifestImpl({
      root: workspace,
      baseCommit: null,
      buildCacheInputs: new Set(),
    });
    expect(
      raw.entries.filter((entry) => entry.type === "directory").map((entry) => entry.path),
    ).toEqual(local.manifest.directories);
    expect(raw.entries.filter((entry) => entry.type !== "directory")).toEqual(
      local.manifest.entries,
    );
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
        {
          path: cachePath,
          type: "file",
          mode: 0o644,
          size: 5,
          sha256: createHash("sha256").update("cache").digest("hex"),
        },
      ].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    });
    const digest = createHash("sha256").update(legacy).digest("hex");
    await fs.mkdir(manifestRoot, { recursive: true });
    const legacyPath = path.join(manifestRoot, `${digest}.json`);
    await fs.writeFile(legacyPath, legacy);
    const expected = serializeWorkerWorkspaceManifest(
      parseWorkerWorkspaceManifest(legacy, `sha256:${digest}`),
    );
    const expectedDigest = createHash("sha256").update(expected).digest("hex");
    const resolved = await runManifest([baseCommit, "resolve", expectedDigest]);
    expect(resolved.code, resolved.stderr).toBe(0);
    expect(resolved.stdout.trim()).toBe(`sha256:${expectedDigest}`);
    const captured = await runManifest([baseCommit, "eligible", digest]);
    expect(captured.code, captured.stderr).toBe(0);
    expect(captured.stdout.trim()).toBe(`sha256:${expectedDigest}`);
    expect(await fs.readFile(legacyPath, "utf8")).toBe(legacy);
    expect(await fs.readFile(path.join(manifestRoot, `${expectedDigest}.json`), "utf8")).toBe(
      current.rawManifest,
    );
  },
);

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
  const generated = ".artifacts/build-all-cache/generated/output.js";
  await writeWorkspaceFiles(workspace, {
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
  await writeWorkspaceFiles(workspace, { [generated]: "disposable cache\n" });

  const captured = await runManifest(["", "all", plainRef.slice(7)]);
  expect(captured.code, captured.stderr).toBe(0);
  const manifest = await readManifest(captured.stdout.trim());
  expect(manifest.entries.some((entry) => entry.path === authored)).toBe(true);
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
