import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

async function makeTempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`));
}

async function makeFakeGitRepo(
  root: string,
  options: {
    head: string;
    refs?: Record<string, string>;
    gitdir?: string;
    commondir?: string;
  },
) {
  await fs.mkdir(root, { recursive: true });
  const gitdir = options.gitdir ?? path.join(root, ".git");
  if (options.gitdir) {
    await fs.writeFile(path.join(root, ".git"), `gitdir: ${options.gitdir}\n`, "utf-8");
  } else {
    await fs.mkdir(gitdir, { recursive: true });
  }
  await fs.mkdir(gitdir, { recursive: true });
  await fs.writeFile(path.join(gitdir, "HEAD"), options.head, "utf-8");
  if (options.commondir) {
    await fs.writeFile(path.join(gitdir, "commondir"), options.commondir, "utf-8");
  }
  for (const [refPath, commit] of Object.entries(options.refs ?? {})) {
    const targetPath = path.join(gitdir, refPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, `${commit}\n`, "utf-8");
  }
}

describe("git commit resolution", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
  });

  it("resolves commit metadata from the caller module root instead of the caller cwd", async () => {
    const repoHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: originalCwd,
      encoding: "utf-8",
    }).trim();

    const temp = await makeTempDir("git-commit-cwd");
    const otherRepo = path.join(temp, "other");
    await fs.mkdir(otherRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: otherRepo });
    await fs.writeFile(path.join(otherRepo, "note.txt"), "x\n", "utf-8");
    execFileSync("git", ["add", "note.txt"], { cwd: otherRepo });
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"],
      { cwd: otherRepo },
    );
    const otherHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: otherRepo,
      encoding: "utf-8",
    }).trim();

    process.chdir(otherRepo);
    const { resolveCommitHash } = await import("./git-commit.js");
    const entryModuleUrl = pathToFileURL(path.join(originalCwd, "src", "entry.ts")).href;

    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).toBe(repoHead);
    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).not.toBe(otherHead);
  });

  it("prefers live git metadata over stale build info in a real checkout", async () => {
    const repoHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: originalCwd,
      encoding: "utf-8",
    }).trim();

    vi.doMock("node:module", () => ({
      createRequire: () => {
        return (specifier: string) => {
          if (specifier === "../build-info.json" || specifier === "./build-info.json") {
            return { commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" };
          }
          throw Object.assign(new Error(`Cannot find module ${specifier}`), {
            code: "MODULE_NOT_FOUND",
          });
        };
      },
    }));
    vi.resetModules();

    const { resolveCommitHash } = await import("./git-commit.js");
    const entryModuleUrl = pathToFileURL(path.join(originalCwd, "src", "entry.ts")).href;

    expect(resolveCommitHash({ moduleUrl: entryModuleUrl, env: {} })).toBe(repoHead);

    vi.doUnmock("node:module");
  });

  it("treats invalid moduleUrl inputs as a fallback hint instead of throwing", async () => {
    const repoHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: originalCwd,
      encoding: "utf-8",
    }).trim();

    const { resolveCommitHash } = await import("./git-commit.js");

    expect(() =>
      resolveCommitHash({ moduleUrl: "not-a-file-url", cwd: originalCwd, env: {} }),
    ).not.toThrow();
    expect(resolveCommitHash({ moduleUrl: "not-a-file-url", cwd: originalCwd, env: {} })).toBe(
      repoHead,
    );
  });

  it("does not walk out of the openclaw package into a host repo", async () => {
    const temp = await makeTempDir("git-commit-package-boundary");
    const hostRepo = path.join(temp, "host");
    await fs.mkdir(hostRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: hostRepo });
    await fs.writeFile(path.join(hostRepo, "host.txt"), "x\n", "utf-8");
    execFileSync("git", ["add", "host.txt"], { cwd: hostRepo });
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"],
      { cwd: hostRepo },
    );

    const packageRoot = path.join(hostRepo, "node_modules", "openclaw");
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.3.8" }),
      "utf-8",
    );
    const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "entry.js")).href;

    vi.doMock("node:module", () => ({
      createRequire: () => {
        return (specifier: string) => {
          if (specifier === "../build-info.json" || specifier === "./build-info.json") {
            return { commit: "feedfacefeedfacefeedfacefeedfacefeedface" };
          }
          if (specifier === "../../package.json") {
            return { name: "openclaw", version: "2026.3.8", gitHead: "badc0ffee0ddf00d" };
          }
          throw Object.assign(new Error(`Cannot find module ${specifier}`), {
            code: "MODULE_NOT_FOUND",
          });
        };
      },
    }));
    vi.resetModules();

    const { resolveCommitHash } = await import("./git-commit.js");

    expect(resolveCommitHash({ moduleUrl, cwd: packageRoot, env: {} })).toBe("feedfac");

    vi.doUnmock("node:module");
  });

  it("caches git lookups per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-cache");
    const repoA = path.join(temp, "repo-a");
    const repoB = path.join(temp, "repo-b");
    await makeFakeGitRepo(repoA, {
      head: "0123456789abcdef0123456789abcdef01234567\n",
    });
    await makeFakeGitRepo(repoB, {
      head: "89abcdef0123456789abcdef0123456789abcdef\n",
    });

    const { resolveCommitHash } = await import("./git-commit.js");

    expect(resolveCommitHash({ cwd: repoA, env: {} })).toBe("0123456");
    expect(resolveCommitHash({ cwd: repoB, env: {} })).toBe("89abcde");
    expect(resolveCommitHash({ cwd: repoA, env: {} })).toBe("0123456");
  });

  it("caches deterministic null results per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-null-cache");
    const repoRoot = path.join(temp, "repo");
    await makeFakeGitRepo(repoRoot, {
      head: "not-a-commit\n",
    });

    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readFileSyncSpy = vi.fn(actualFs.readFileSync);
    vi.doMock("node:fs", () => ({
      ...actualFs,
      default: {
        ...actualFs,
        readFileSync: readFileSyncSpy,
      },
      readFileSync: readFileSyncSpy,
    }));
    vi.resetModules();

    const { resolveCommitHash } = await import("./git-commit.js");

    expect(resolveCommitHash({ cwd: repoRoot, env: {} })).toBeNull();
    const firstCallReads = readFileSyncSpy.mock.calls.length;
    expect(firstCallReads).toBeGreaterThan(0);
    expect(resolveCommitHash({ cwd: repoRoot, env: {} })).toBeNull();
    expect(readFileSyncSpy.mock.calls.length).toBe(firstCallReads);

    vi.doUnmock("node:fs");
  });

  it("formats env-provided commit strings consistently", async () => {
    const temp = await makeTempDir("git-commit-env");
    const { resolveCommitHash } = await import("./git-commit.js");

    expect(resolveCommitHash({ cwd: temp, env: { GIT_COMMIT: "ABCDEF0123456789" } })).toBe(
      "abcdef0",
    );
    expect(
      resolveCommitHash({ cwd: temp, env: { GIT_SHA: "commit abcdef0123456789 dirty" } }),
    ).toBe("abcdef0");
    expect(resolveCommitHash({ cwd: temp, env: { GIT_COMMIT: "not-a-sha" } })).toBeNull();
    expect(resolveCommitHash({ cwd: temp, env: { GIT_COMMIT: "" } })).toBeNull();
  });

  it("rejects unsafe HEAD refs and accepts valid refs", async () => {
    const temp = await makeTempDir("git-commit-refs");
    const { resolveCommitHash } = await import("./git-commit.js");

    const absoluteRepo = path.join(temp, "absolute");
    await makeFakeGitRepo(absoluteRepo, { head: "ref: /tmp/evil\n" });
    expect(resolveCommitHash({ cwd: absoluteRepo, env: {} })).toBeNull();

    const traversalRepo = path.join(temp, "traversal");
    await makeFakeGitRepo(traversalRepo, { head: "ref: refs/heads/../evil\n" });
    expect(resolveCommitHash({ cwd: traversalRepo, env: {} })).toBeNull();

    const invalidPrefixRepo = path.join(temp, "invalid-prefix");
    await makeFakeGitRepo(invalidPrefixRepo, { head: "ref: heads/main\n" });
    expect(resolveCommitHash({ cwd: invalidPrefixRepo, env: {} })).toBeNull();

    const validRepo = path.join(temp, "valid");
    await makeFakeGitRepo(validRepo, {
      head: "ref: refs/heads/main\n",
      refs: {
        "refs/heads/main": "fedcba9876543210fedcba9876543210fedcba98",
      },
    });
    expect(resolveCommitHash({ cwd: validRepo, env: {} })).toBe("fedcba9");
  });

  it("resolves refs from the git commondir in worktree layouts", async () => {
    const temp = await makeTempDir("git-commit-worktree");
    const repoRoot = path.join(temp, "repo");
    const worktreeGitDir = path.join(temp, "worktree-git");
    const commonGitDir = path.join(temp, "common-git");
    await fs.mkdir(commonGitDir, { recursive: true });
    const refPath = path.join(commonGitDir, "refs", "heads", "main");
    await fs.mkdir(path.dirname(refPath), { recursive: true });
    await fs.writeFile(refPath, "76543210fedcba9876543210fedcba9876543210\n", "utf-8");
    await makeFakeGitRepo(repoRoot, {
      gitdir: worktreeGitDir,
      head: "ref: refs/heads/main\n",
      commondir: "../common-git",
    });

    const { resolveCommitHash } = await import("./git-commit.js");

    expect(resolveCommitHash({ cwd: repoRoot, env: {} })).toBe("7654321");
  });

  it("reads full HEAD refs before parsing long branch names", async () => {
    const temp = await makeTempDir("git-commit-long-head");
    const repoRoot = path.join(temp, "repo");
    const longRefName = `refs/heads/${"segment/".repeat(40)}main`;
    await makeFakeGitRepo(repoRoot, {
      head: `ref: ${longRefName}\n`,
      refs: {
        [longRefName]: "0123456789abcdef0123456789abcdef01234567",
      },
    });

    const { resolveCommitHash } = await import("./git-commit.js");

    expect(resolveCommitHash({ cwd: repoRoot, env: {} })).toBe("0123456");
  });
});
