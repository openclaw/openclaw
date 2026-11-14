import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { gitCommitPrefixesMatch } from "./git-commit.js";

const tempDirs = createTrackedTempDirs();
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const OTHER_SHA = "b".repeat(40);
const MAIN = "refs/heads/main";
const tempDir = () => tempDirs.make("openclaw-git-commit-");

it("normalizes whitespace and case when matching commit prefixes", () => {
  expect(gitCommitPrefixesMatch("  ABCDEF0  ", SHA)).toBe(true);
});

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
  }
}

async function makeFakeGitRepo(
  options: {
    head?: string;
    refs?: Record<string, string>;
  } = {},
  targetRoot?: string,
) {
  const root = targetRoot ?? (await tempDir());
  const gitdir = path.join(root, ".git");
  await writeFiles(gitdir, { HEAD: options.head ?? `${SHA}\n` });
  await writeFiles(
    gitdir,
    Object.fromEntries(
      Object.entries(options.refs ?? {}).map(([ref, commit]) => [ref, `${commit}\n`]),
    ),
  );
  return root;
}

async function makeFakeOpenClawPackage(root: string) {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
}

const writeJson = (root: string, name: string, value: object) =>
  fs.writeFile(path.join(root, name), JSON.stringify(value));

describe("git commit resolution", () => {
  let gitRoot: typeof import("./git-root.js");
  const packageJson = vi.fn<() => { gitHead?: string }>(() => ({}));
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
    vi.doMock("node:module", async (importOriginal) => {
      const { createRequire, ...actual } = await importOriginal<typeof import("node:module")>();
      return {
        ...actual,
        createRequire: (filename: string | URL) =>
          filename === new URL("./git-commit.ts", import.meta.url).href
            ? packageJson
            : createRequire(filename),
      };
    });
    vi.resetModules();
    gitRoot = await import("./git-root.js");
    ({ resolveCommitHash, resolveLoadedCommitHash } = await import("./git-commit.js"));
  });
  afterAll(() => vi.doUnmock("node:module"));

  afterEach(async () => {
    vi.restoreAllMocks();
    packageJson.mockReset();
    await tempDirs.cleanup();
  });

  it("resolves commit metadata from the caller module root instead of the caller cwd", async () => {
    const temp = await tempDir();
    const repoRoot = path.join(temp, "openclaw");
    await makeFakeGitRepo({}, repoRoot);
    await makeFakeOpenClawPackage(repoRoot);

    const otherRepo = path.join(temp, "other");
    const otherCommit = "1234567890abcdef1234567890abcdef12345678";
    await makeFakeGitRepo({ head: otherCommit }, otherRepo);

    const entryModuleUrl = pathToFileURL(path.join(repoRoot, "src", "entry.ts")).href;
    vi.spyOn(process, "cwd").mockReturnValue(otherRepo);

    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).toBe("abcdef0");
  });

  it.each([
    ["a", "aaaaaaa"],
    ["c", null],
  ] as const)(
    "uses only matching local build stamps (runtime stamp: %s)",
    async (runtimePrefix, expected) => {
      const root = await makeFakeGitRepo({ head: `${OTHER_SHA}\n` });
      const dist = path.join(root, "dist");
      await fs.mkdir(dist, { recursive: true });
      await writeJson(dist, ".buildstamp", { head: "a".repeat(40) });
      await writeJson(dist, ".runtime-postbuildstamp", { head: runtimePrefix.repeat(40) });
      expect(loaded(root, undefined, { GIT_COMMIT: OTHER_SHA })).toBe(expected);
    },
  );

  it("uses build info when source-archive stamps have no Git head", async () => {
    const root = await tempDir();
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
    const root = await makeFakeGitRepo({ head: `${OTHER_SHA}\n` });

    expect(loaded(root, "src/version.ts")).toBe("bbbbbbb");
  });

  it.each(["package.json", "caught null"] as const)(
    "caches %s results per search directory",
    async (source) => {
      const root = source === "caught null" ? await makeFakeGitRepo() : await tempDir();
      const expected = source === "caught null" ? null : "badc0ff";
      vi.spyOn(gitRoot, "readGitMetadataPrefix").mockReturnValue("{}");
      const probe =
        source === "caught null"
          ? vi.spyOn(gitRoot, "readGitHead").mockImplementation(() => {
              throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
            })
          : packageJson.mockReturnValue({ gitHead: "badc0ff" });
      expect(resolveAt(root)).toBe(expected);
      const reads = probe.mock.calls.length;
      if (source === "caught null") {
        expect(reads).toBe(1);
      } else {
        expect(reads).toBeGreaterThan(0);
      }
      expect(resolveAt(root)).toBe(expected);
      expect(probe).toHaveBeenCalledTimes(reads);
    },
  );

  it("formats env-provided commit strings consistently", async () => {
    const temp = await tempDir();
    expect(resolveAt(temp, { env: { GIT_COMMIT: "ABCDEF0123456789" } })).toBe("abcdef0");
    expect(resolveAt(temp, { env: { GIT_SHA: "commit abcdef0123456789 dirty" } })).toBe("abcdef0");
    expect(resolveAt(temp, { env: { GIT_COMMIT: "not-a-sha" } })).toBeNull();
    expect(resolveAt(temp, { env: { GIT_COMMIT: "" } })).toBeNull();
  });

  it("rejects unsafe HEAD refs and accepts valid refs", async () => {
    const temp = await tempDir();
    for (const [name, ref] of [
      ["absolute", "/tmp/evil"],
      ["traversal", "refs/heads/../evil"],
      ["invalid-prefix", "heads/main"],
    ] as const) {
      const root = path.join(temp, name);
      await makeFakeGitRepo({ head: `ref: ${ref}\n` }, root);
      expect(resolveAt(root)).toBeNull();
    }

    const validRepo = await makeFakeGitRepo({
      head: `ref: ${MAIN}\n`,
      refs: { [MAIN]: "a".repeat(40) },
    });
    expect(resolveCommitHash({ cwd: validRepo, env: {} })).toBe("aaaaaaa");
  });

  it("falls back to baked metadata when a bounded Git metadata read errors", async () => {
    const repoRoot = await makeFakeGitRepo({
      head: `ref: ${MAIN}\n`,
      refs: { [MAIN]: SHA },
    });
    vi.spyOn(fsSync, "readSync").mockImplementationOnce((() => {
      throw Object.assign(new Error("EIO: forced read failure"), { code: "EIO" });
    }) as typeof fsSync.readSync);

    vi.spyOn(gitRoot, "readGitMetadataPrefix").mockReturnValue('{"commit":"deadbee"}');
    expect(resolveAt(repoRoot)).toBe("deadbee");
  });
});
