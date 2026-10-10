import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as gitExec from "../../infra/git-exec.js";
import * as commands from "../../process/exec.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));
const exec = promisify(execFile);
const sessionDirs = useSessionStoreTempDirs(afterAll, "source-only-filters-");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
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
  root = sessionDirs.make();
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
  await fs.mkdir(path.join(repo, ".openclaw"));
  await fs.writeFile(
    path.join(repo, ".openclaw/worktree-setup.sh"),
    `#!/bin/sh\nprintf executed >> "${marker}"\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(repo, ".gitattributes"), "README.md filter=late\n");
  await git(repo, "add", ".gitattributes");
  await git(repo, "commit", "-qm", "filter attributes");
  vi.mocked(detectWorktreeFilesystemBackend).mockResolvedValue(createCopyWorktreeBackend());
  service = new ManagedWorktreeService({ getConfig: () => ({}) });
});

async function createSourceOnly(name: string, sessionId?: string) {
  const created = await service.create({
    repoRoot: repo,
    name,
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: `agent:main:${name}`,
    runSetupScript: false,
    provisionIgnoredFiles: false,
  });
  if (sessionId) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: created.ownerId! },
      {
        sessionId,
        updatedAt: Date.now(),
        sandbox: "required",
        worktree: { id: created.id, branch: created.branch, repoRoot: repo },
      },
    );
  }
  return created;
}

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
    const created = await createSourceOnly("guest");
    expect(injected).toBe(true);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(created.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/${created.branch}`);
    expect(await git(created.path, "rev-parse", "--git-common-dir")).toBe(
      await git(repo, "rev-parse", "--absolute-git-dir"),
    );
    const replayed = await createSourceOnly("guest");
    expect(replayed.id).toBe(created.id);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("fast-forwards the source default without executing clean or smudge filters", async () => {
  await git(repo, "add", ".openclaw");
  await git(repo, "commit", "-qm", "source setup");
  await fs.writeFile(path.join(repo, "README.md"), "remote update\n");
  await git(repo, "add", "README.md");
  const tree = await git(repo, "write-tree");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  const commit = await git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "remote update");
  await git(repo, "push", "origin", `${commit}:refs/heads/main`);
  await git(path.join(root, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/main");
  await configure("repository", "clean", repo);
  await configure("repository", "smudge", repo);
  // Force status to examine file contents instead of reusing its index stat cache.
  await fs.writeFile(path.join(repo, "README.md"), "base\n");

  const created = await service.create({
    repoRoot: repo,
    name: "fresh-guest",
    ownerKind: "session",
    ownerId: "agent:main:fresh-guest",
    runSetupScript: false,
    provisionIgnoredFiles: false,
  });

  expect(await git(repo, "rev-parse", "HEAD")).toBe(commit);
  expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe("remote update\n");
  expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("remote update\n");
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")(
  "reads signed commit age without running the host signature verifier",
  async () => {
    const unsigned = await git(repo, "cat-file", "commit", "HEAD");
    const signed = unsigned.replace(
      "\n\n",
      "\ngpgsig -----BEGIN PGP SIGNATURE-----\n test-only\n -----END PGP SIGNATURE-----\n\n",
    );
    const objectFile = path.join(root, "signed-commit");
    await fs.writeFile(objectFile, signed);
    const commit = await git(repo, "hash-object", "-t", "commit", "-w", objectFile);
    const verifier = path.join(root, "verify-signature");
    await fs.writeFile(
      verifier,
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(marker)}, "verified\\n");\n`,
      { mode: 0o755 },
    );
    await git(repo, "config", "log.showSignature", "true");
    await git(repo, "config", "gpg.program", verifier);
    // Prove the configured verifier is executable before exercising creation.
    await git(repo, "show", "-s", "--format=%ct", commit);
    expect(await fs.readFile(marker, "utf8")).toContain("verified");
    await fs.unlink(marker);

    await service.create({
      repoRoot: repo,
      name: "signed",
      baseRef: commit,
      runSetupScript: false,
      provisionIgnoredFiles: false,
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("archives before first execution and restores without running late clean/smudge programs", async () => {
  const created = await createSourceOnly("before-run", "first-run-not-admitted");
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
  const created = await createSourceOnly("publication", "publication");
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

it("keeps native lossless removal checks when a late file appears with filters configured", async () => {
  await git(repo, "push", "origin", "main");
  const created = await createSourceOnly("lossless", "lossless");
  await configure("repository", "clean", created.path);
  await fs.utimes(path.join(created.path, "README.md"), new Date(0), new Date(0));
  const run = gitExec.executeGitCommand;
  const removals: string[][] = [];
  vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
    if (args[0] === "worktree" && args[1] === "remove") {
      removals.push(args);
      await fs.writeFile(path.join(created.path, "late.txt"), "preserved user bytes");
    }
    return await run(cwd, args, options);
  });
  await expect(service.removeIfLossless(created.id)).rejects.toThrow();
  expect(await fs.readFile(path.join(created.path, "late.txt"), "utf8")).toBe(
    "preserved user bytes",
  );
  expect(removals).toHaveLength(1);
  expect(removals[0]).not.toContain("--force");
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
