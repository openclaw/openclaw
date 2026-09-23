import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as commands from "../../process/exec.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));
const exec = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const initialize = useManagedWorktreeTestRepository();
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", ["-C", cwd, ...args])).stdout.trim();
let root: string,
  repo: string,
  globalConfig: string,
  marker: string,
  script: string,
  service: ManagedWorktreeService;
beforeEach(async () => {
  root = tempDirs.make("source-only-filters-");
  globalConfig = path.join(root, "global-config");
  await fs.writeFile(globalConfig, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_SYSTEM", os.devNull);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  repo = await initialize(root);
  marker = path.join(root, "host-marker");
  script = path.join(root, "filter.cjs");
  await fs.writeFile(
    script,
    'const fs = require("node:fs"); fs.appendFileSync(process.argv[2], "executed\\n"); if (process.argv[3] === "process") process.exit(1); process.stdout.write(fs.readFileSync(0));',
  );
  await fs.writeFile(path.join(repo, ".gitattributes"), "README.md filter=late\n");
  await git(repo, "add", ".gitattributes");
  await git(repo, "commit", "-qm", "filter attributes");
  vi.mocked(detectWorktreeFilesystemBackend).mockResolvedValue(createCopyWorktreeBackend());
  service = new ManagedWorktreeService({ getConfig: () => ({}) });
});

async function configure(scope: string, kind: string, cwd: string) {
  const command = `"${process.execPath}" "${script}" "${marker}" ${kind}`;
  if (scope === "worktree") {
    await git(repo, "config", "extensions.worktreeConfig", "true");
    await git(cwd, "config", "--worktree", `filter.late.${kind}`, command);
  } else if (scope === "include") {
    const included = path.join(root, "included-config");
    await fs.writeFile(included, "");
    await git(repo, "config", "--file", globalConfig, "include.path", included);
    await git(repo, "config", "--file", included, `filter.late.${kind}`, command);
  } else {
    await git(repo, "config", `filter.late.${kind}`, command);
  }
}

it.each([
  ["repository", "smudge"],
  ["include", "process"],
  ["worktree", "process"],
])(
  "does not execute a late %s %s filter during source-only materialization",
  async (scope, kind) => {
    await expect(
      git(repo, "config", "--includes", "--get-regexp", "^filter\\."),
    ).rejects.toMatchObject({ code: 1 });
    const run = commands.runCommandWithTimeout;
    let injected = false;
    vi.spyOn(commands, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const argv = args[0];
      if (
        !injected &&
        argv[0] === "git" &&
        ((argv.includes("read-tree") && argv.includes("-u")) ||
          (argv.includes("worktree") && argv.includes("add") && !argv.includes("--no-checkout")))
      ) {
        injected = true;
        await configure(scope, kind, argv[argv.indexOf("-C") + 1]!);
      }
      return await run(...args);
    });
    const created = await service.create({
      repoRoot: repo,
      name: "guest",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:guest",
      runSetupScript: false,
      provisionIgnoredFiles: false,
    });
    expect(injected).toBe(true);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(created.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/${created.branch}`);
    expect(await git(created.path, "rev-parse", "--git-common-dir")).toBe(
      await git(repo, "rev-parse", "--absolute-git-dir"),
    );
    const replayed = await service.create({
      repoRoot: repo,
      name: "guest",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:guest",
      runSetupScript: false,
      provisionIgnoredFiles: false,
    });
    expect(replayed.id).toBe(created.id);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("archives before first execution and restores without running late clean/smudge programs", async () => {
  const created = await service.create({
    repoRoot: repo,
    name: "before-run",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: "agent:main:before-run",
    runSetupScript: false,
    provisionIgnoredFiles: false,
  });
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: created.ownerId! },
    {
      sessionId: "first-run-not-admitted",
      updatedAt: Date.now(),
      sandbox: "required",
      worktree: { id: created.id, branch: created.branch, repoRoot: repo },
    },
  );
  const ignore = path.join(root, "global-ignore");
  await fs.writeFile(ignore, "private.secret\n");
  await git(repo, "config", "--file", globalConfig, "core.excludesFile", ignore);
  await fs.writeFile(path.join(created.path, "private.secret"), "must not enter snapshot");
  await configure("include", "clean", created.path);
  await fs.writeFile(path.join(created.path, "README.md"), "accepted before first run\n");
  const originalHead = await git(created.path, "rev-parse", "HEAD");
  const removed = await service.remove({ id: created.id, reason: "archive-before-run" });
  expect(removed.removed).toBe(true);
  expect(await git(repo, "ls-tree", "-r", "--name-only", removed.snapshotRef!)).not.toContain(
    "private.secret",
  );
  await configure("repository", "smudge", repo);
  const restored = await service.restore({ id: created.id });
  expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
    "accepted before first run\n",
  );
  expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not execute a clean filter inserted after publication preflight", async () => {
  const { captureGitHubPublicationWorkspaceSnapshot } =
    await import("../../gateway/github-publication-git-transport.js");
  const created = await service.create({
    repoRoot: repo,
    name: "publication",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: "agent:main:publication",
    runSetupScript: false,
    provisionIgnoredFiles: false,
  });
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: created.ownerId! },
    {
      sessionId: "publication",
      updatedAt: Date.now(),
      sandbox: "required",
      worktree: { id: created.id, branch: created.branch, repoRoot: repo },
    },
  );
  await fs.writeFile(path.join(created.path, "README.md"), "changed for publication\n");
  const head = await git(created.path, "rev-parse", "HEAD");
  const index = path.resolve(
    created.path,
    await git(created.path, "rev-parse", "--git-path", "index"),
  );
  const before = await fs.readFile(index);
  const run = commands.runCommandWithTimeout;
  let injected = false;
  vi.spyOn(commands, "runCommandWithTimeout").mockImplementation(async (...args) => {
    if (!injected && args[0][0] === "git" && args[0].includes("add") && args[0].includes("-A")) {
      injected = true;
      await configure("repository", "clean", created.path);
    }
    return await run(...args);
  });
  await expect(captureGitHubPublicationWorkspaceSnapshot({ cwd: created.path })).rejects.toThrow(
    /filter/i,
  );
  expect(injected).toBe(true);
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(index)).toEqual(before);
  expect(await git(created.path, "rev-parse", "HEAD")).toBe(head);
});

it.each([false, true])(
  "keeps native lossless removal checks with filters configured (late file=%s)",
  async (lateFile) => {
    await git(repo, "push", "origin", "main");
    const created = await service.create({
      repoRoot: repo,
      name: "lossless",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:lossless",
      runSetupScript: false,
      provisionIgnoredFiles: false,
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: created.ownerId! },
      {
        sessionId: "lossless",
        updatedAt: Date.now(),
        sandbox: "required",
        worktree: { id: created.id, branch: created.branch, repoRoot: repo },
      },
    );
    await configure("repository", "clean", created.path);
    await fs.utimes(path.join(created.path, "README.md"), new Date(0), new Date(0));
    const run = commands.runCommandWithTimeout;
    let reachedRemoval = false;
    vi.spyOn(commands, "runCommandWithTimeout").mockImplementation(async (...args) => {
      if (args[0][0] === "git" && args[0].includes("worktree") && args[0].includes("remove")) {
        reachedRemoval = true;
        if (lateFile) {
          await fs.writeFile(path.join(created.path, "late.txt"), "preserved user bytes");
        }
      }
      return await run(...args);
    });
    if (lateFile) {
      await expect(service.removeIfLossless(created.id)).rejects.toThrow();
      expect(await fs.readFile(path.join(created.path, "late.txt"), "utf8")).toBe(
        "preserved user bytes",
      );
    } else {
      expect(await service.removeIfLossless(created.id)).toBe(true);
    }
    expect(reachedRemoval).toBe(true);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("preserves ordinary trusted checkout filter semantics", async () => {
  await configure("repository", "smudge", repo);
  await service.create({ repoRoot: repo, name: "trusted", baseRef: "HEAD" });
  expect(await fs.readFile(marker, "utf8")).toContain("executed");
});
