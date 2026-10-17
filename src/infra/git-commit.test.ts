// Covers git commit helper behavior in fake repositories.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { gitCommitPrefixesMatch } from "./git-commit.js";

const tempDirs = createTrackedTempDirs();

it("normalizes whitespace and case when matching commit prefixes", () => {
  expect(gitCommitPrefixesMatch("  ABCDEF0  ", "abcdef0123456789abcdef0123456789abcdef01")).toBe(
    true,
  );
});

async function makeTempDir(label: string): Promise<string> {
  return await tempDirs.make(`openclaw-${label}-`);
}

async function makeFakeGitRepo(
  root: string,
  options: {
    head: string;
    packedRefs?: Record<string, string>;
    refs?: Record<string, string>;
    gitdir?: string;
    commondir?: string;
  },
) {
  await fs.mkdir(root, { recursive: true });
  const gitdir = options.gitdir ?? path.join(root, ".git");
  if (options.gitdir) {
    await fs.writeFile(path.join(root, ".git"), `gitdir: ${options.gitdir}\n`, "utf-8");
  }
  await fs.mkdir(gitdir, { recursive: true });
  await fs.writeFile(path.join(gitdir, "HEAD"), options.head, "utf-8");
  const refsBase = options.commondir ? path.resolve(gitdir, options.commondir) : gitdir;
  await fs.mkdir(refsBase, { recursive: true });
  if (options.commondir) {
    await fs.writeFile(path.join(gitdir, "commondir"), options.commondir, "utf-8");
  }
  for (const [refPath, commit] of Object.entries(options.refs ?? {})) {
    const targetPath = path.join(refsBase, refPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, `${commit}\n`, "utf-8");
  }
  const packedRefsEntries = Object.entries(options.packedRefs ?? {});
  if (packedRefsEntries.length > 0) {
    const packedRefsContents = [
      "# pack-refs with: peeled fully-peeled sorted",
      ...packedRefsEntries.map(([refPath, commit]) => `${commit} ${refPath}`),
    ].join("\n");
    await fs.writeFile(path.join(refsBase, "packed-refs"), `${packedRefsContents}\n`, "utf-8");
  }
}

async function makeFakeOpenClawPackage(root: string) {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
}

const writeJson = (root: string, name: string, value: object) =>
  fs.writeFile(path.join(root, name), JSON.stringify(value));

function limitPositionalReads(maxBytes: number) {
  const realReadSync = fsSync.readSync.bind(fsSync);
  vi.spyOn(fsSync, "readSync").mockImplementation(((
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    return realReadSync(fd, buffer, offset, Math.min(length, maxBytes), position);
  }) as typeof fsSync.readSync);
}

describe("git commit resolution", () => {
  let resolveCommitHash: (typeof import("./git-commit.js"))["resolveCommitHash"];
  let resolveLoadedCommitHash: (typeof import("./git-commit.js"))["resolveLoadedCommitHash"];
  const resolveAt = (cwd: string, options: Parameters<typeof resolveCommitHash>[0] = {}) =>
    resolveCommitHash({ cwd, env: {}, ...options });
  const loaded = (root: string, entry = "dist/version-chunk.js", env: NodeJS.ProcessEnv = {}) =>
    resolveLoadedCommitHash({ env, moduleUrl: pathToFileURL(path.join(root, entry)).href });

  // Unique fixture paths isolate cache entries without reloading the owner for each case.
  beforeAll(async () => {
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.doUnmock("node:module");
    vi.resetModules();
    ({ resolveCommitHash, resolveLoadedCommitHash } = await import("./git-commit.js"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tempDirs.cleanup();
  });

  it("resolves commit metadata from the caller module root instead of the caller cwd", async () => {
    const temp = await makeTempDir("git-commit-cwd");
    const repoRoot = path.join(temp, "openclaw");
    const repoCommit = "abcdef0123456789abcdef0123456789abcdef01";
    await makeFakeGitRepo(repoRoot, { head: `${repoCommit}\n` });
    await makeFakeOpenClawPackage(repoRoot);

    const otherRepo = path.join(temp, "other");
    const otherCommit = "1234567890abcdef1234567890abcdef12345678";
    await makeFakeGitRepo(otherRepo, { head: otherCommit });

    const entryModuleUrl = pathToFileURL(path.join(repoRoot, "src", "entry.ts")).href;
    vi.spyOn(process, "cwd").mockReturnValue(otherRepo);

    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).toBe(repoCommit.slice(0, 7));
    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).not.toBe(otherCommit.slice(0, 7));
  });

  it.each([
    {
      name: "uses matching local build stamps",
      buildCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      runtimeCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expected: "aaaaaaa",
    },
    {
      name: "rejects conflicting local build stamps",
      buildCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      runtimeCommit: "cccccccccccccccccccccccccccccccccccccccc",
      expected: null,
    },
  ])(
    "$name instead of mutable checkout metadata",
    async ({ buildCommit, runtimeCommit, expected }) => {
      const root = await makeTempDir("git-commit-loaded-build");
      const dist = path.join(root, "dist");
      await makeFakeGitRepo(root, {
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
      });
      await fs.mkdir(dist, { recursive: true });
      await writeJson(dist, ".buildstamp", { head: buildCommit });
      await writeJson(dist, ".runtime-postbuildstamp", { head: runtimeCommit });
      expect(
        loaded(root, undefined, { GIT_COMMIT: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      ).toBe(expected);
    },
  );

  it("uses build info when source-archive stamps have no Git head", async () => {
    const root = await makeTempDir("git-commit-headless-build");
    const dist = path.join(root, "dist");
    await fs.mkdir(dist, { recursive: true });
    await writeJson(dist, ".buildstamp", { head: null });
    await writeJson(dist, ".runtime-postbuildstamp", {});
    await writeJson(dist, "build-info.json", {
      commit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(loaded(root)).toBe("0123456");
  });

  it("falls back to Git for true source execution without build metadata", async () => {
    const root = await makeTempDir("git-commit-source-runtime");
    await makeFakeGitRepo(root, {
      head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
    });

    expect(loaded(root, "src/version.ts")).toBe("bbbbbbb");
  });

  it("caches package.json fallback results per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-package-json-cache");
    const readPackageJsonCommit = vi.fn(() => "badc0ff");

    const read = () =>
      resolveAt(temp, {
        readers: { readBuildInfoCommit: () => null, readPackageJsonCommit },
      });
    expect(read()).toBe("badc0ff");
    const firstCallRequires = readPackageJsonCommit.mock.calls.length;
    expect(firstCallRequires).toBeGreaterThan(0);
    expect(read()).toBe("badc0ff");
    expect(readPackageJsonCommit.mock.calls.length).toBe(firstCallRequires);
  });

  it("treats invalid moduleUrl inputs as a fallback hint instead of throwing", async () => {
    const temp = await makeTempDir("git-commit-invalid-module-url");
    const repoRoot = path.join(temp, "openclaw");
    const repoCommit = "abcdef0123456789abcdef0123456789abcdef01";
    await makeFakeGitRepo(repoRoot, { head: `${repoCommit}\n` });
    await makeFakeOpenClawPackage(repoRoot);

    expect(resolveCommitHash({ moduleUrl: "not-a-file-url", cwd: repoRoot, env: {} })).toBe(
      repoCommit.slice(0, 7),
    );
  });

  it("reads packed refs after short commondir reads in worktree-style checkouts", async () => {
    const temp = await makeTempDir("git-commit-packed-refs");
    const checkoutRoot = path.join(temp, "checkout");
    const commonGitDir = path.join(temp, "git-common");
    const worktreeGitDir = path.join(commonGitDir, "worktrees", "checkout");

    await makeFakeGitRepo(checkoutRoot, {
      gitdir: worktreeGitDir,
      commondir: "../..",
      head: "ref: refs/heads/main\n",
      packedRefs: {
        "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
      },
    });
    limitPositionalReads(4);

    expect(resolveCommitHash({ cwd: checkoutRoot, env: {} })).toBe("0123456");
  });

  it("caches caught null fallback results per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-caught-null-cache");
    const repoRootResult = path.join(temp, "repo");
    await makeFakeGitRepo(repoRootResult, {
      head: "0123456789abcdef0123456789abcdef01234567\n",
    });
    const readGitCommit = vi.fn(() => {
      const error = Object.assign(new Error(`EACCES: permission denied`), {
        code: "EACCES",
      });
      throw error;
    });

    const read = () =>
      resolveAt(repoRootResult, {
        readers: {
          readGitCommit,
          readBuildInfoCommit: () => null,
          readPackageJsonCommit: () => null,
        },
      });
    expect(read()).toBeNull();
    const firstCallReads = readGitCommit.mock.calls.length;
    expect(firstCallReads).toBe(2);
    expect(read()).toBeNull();
    expect(readGitCommit.mock.calls.length).toBe(firstCallReads);
  });

  it("bounds successful git probe entries with LRU eviction", async () => {
    const result = "abcdef0";
    const temp = await makeTempDir("git-commit-success-lru");
    const coldDir = path.join(temp, "cold");
    const hotDir = path.join(temp, "hot");
    const newestDir = path.join(temp, "newest");
    const readGitCommit = vi.fn((_searchDir: string, _packageRoot: string | null) => result);
    const resolve = (cwd: string) =>
      resolveCommitHash({
        cwd,
        env: {},
        readers: {
          readGitCommit,
          readBuildInfoCommit: () => null,
          readPackageJsonCommit: () => null,
        },
      });
    const callsFor = (cwd: string) =>
      readGitCommit.mock.calls.filter(([searchDir]) => searchDir === cwd).length;

    expect(resolve(coldDir)).toBe(result);
    expect(resolve(hotDir)).toBe(result);
    for (let index = 0; index < 254; index += 1) {
      expect(resolve(path.join(temp, `filler-${index}`))).toBe(result);
    }

    expect(resolve(hotDir)).toBe(result);
    expect(resolve(newestDir)).toBe(result);
    expect(resolve(newestDir)).toBe(result);
    expect(resolve(hotDir)).toBe(result);
    expect(resolve(coldDir)).toBe(result);

    expect(callsFor(newestDir)).toBe(1);
    expect(callsFor(hotDir)).toBe(1);
    expect(callsFor(coldDir)).toBe(2);
  });

  it("formats env-provided commit strings consistently", async () => {
    const temp = await makeTempDir("git-commit-env");
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
    for (const [name, ref] of [
      ["absolute", "/tmp/evil"],
      ["traversal", "refs/heads/../evil"],
      ["invalid-prefix", "heads/main"],
    ] as const) {
      const root = path.join(temp, name);
      await makeFakeGitRepo(root, { head: `ref: ${ref}\n` });
      expect(resolveAt(root)).toBeNull();
    }

    const validRepo = path.join(temp, "valid");
    await makeFakeGitRepo(validRepo, {
      head: "ref: refs/heads/main\n",
      refs: {
        "refs/heads/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(resolveCommitHash({ cwd: validRepo, env: {} })).toBe("aaaaaaa");
  });

  it("falls back to baked metadata when a bounded Git metadata read errors", async () => {
    const temp = await makeTempDir("git-commit-read-error");
    const repoRoot = path.join(temp, "repo");
    await makeFakeGitRepo(repoRoot, {
      head: "ref: refs/heads/main\n",
      refs: {
        "refs/heads/main": "abcdef0123456789abcdef0123456789abcdef01",
      },
    });
    vi.spyOn(fsSync, "readSync").mockImplementationOnce((() => {
      throw Object.assign(new Error("EIO: forced read failure"), { code: "EIO" });
    }) as typeof fsSync.readSync);

    expect(
      resolveCommitHash({
        cwd: repoRoot,
        env: {},
        readers: { readBuildInfoCommit: () => "deadbee" },
      }),
    ).toBe("deadbee");
  });
});
