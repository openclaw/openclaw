import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import * as execRunner from "../../process/exec-runner.js";
import * as commandExec from "../../process/exec.js";
import { estimateWorktreeCheckoutTransitionBytes, estimateWorktreeGitBytes } from "./capacity.js";
import { runGit } from "./git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("worktree Git size estimates", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function partialClone() {
    const root = tempDirs.make("openclaw-partial-worktree-");
    const source = path.join(root, "source");
    const origin = path.join(root, "origin.git");
    const clone = path.join(root, "clone");
    await git(root, "init", "--template=", "-b", "main", source);
    await git(source, "config", "user.name", "OpenClaw Test");
    await git(source, "config", "user.email", "openclaw-test@example.invalid");
    await git(source, "config", "commit.gpgSign", "false");
    await fs.writeFile(path.join(source, "base.txt"), "base\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "initial");
    await git(root, "clone", "--bare", source, origin);
    await git(origin, "config", "uploadpack.allowFilter", "true");
    await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    await git(root, "clone", "--filter=blob:none", pathToFileURL(origin).href, clone);
    await fs.writeFile(path.join(source, "small.txt"), "small\n");
    await fs.writeFile(path.join(source, "large.txt"), "x".repeat(5000));
    await git(source, "add", ".");
    await git(source, "commit", "-m", "add absent blobs");
    await git(source, "push", origin, "main");
    await git(clone, "fetch", "origin");
    const commit = await git(clone, "rev-parse", "origin/main");
    vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
    const missing = (
      await git(
        clone,
        "rev-list",
        "--objects",
        "--missing=print",
        "--no-object-names",
        "--max-count=1",
        commit,
      )
    )
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
    expect(missing).toHaveLength(2);
    // The production executor inherits this guard, so old objectsize cannot hydrate the fixture.
    await expect(runGit(clone, ["cat-file", "-e", missing[0]!])).resolves.toMatchObject({
      code: 1,
    });
    return { root, source, origin, clone, commit, missing };
  }

  it("preserves admitted caller ownership config through text and buffered sizing without changing defaults", async () => {
    const root = tempDirs.make("openclaw-capacity-caller-git-");
    const repo = path.join(root, "repo");
    await git(root, "init", "--template=", "-b", "main", repo);
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await git(repo, "config", "commit.gpgSign", "false");
    await fs.writeFile(path.join(repo, "README.md"), "capacity\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", gitExec.gitNullConfigPath());
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "safe.directory");
    vi.stubEnv("GIT_CONFIG_VALUE_0", await fs.realpath(repo));
    // Managed Git intentionally replaces caller config with its hook/fsmonitor policy.
    await expect(estimateWorktreeGitBytes(repo, "HEAD")).rejects.toThrow("dubious ownership");
    const pending = estimateWorktreeGitBytes(repo, "HEAD", {
      git: {
        text: gitExec.executeGitCommandBytes,
        buffered: gitExec.executeGitCommandBuffered,
      },
    });
    // Later caller changes must not replace the environment captured at admission.
    vi.stubEnv("GIT_CONFIG_VALUE_0", path.join(root, "not-the-repository"));
    await expect(pending).resolves.toBe(4096);
    await expect(estimateWorktreeGitBytes(repo, "HEAD")).rejects.toThrow("dubious ownership");
  });

  it.each(["remote promisor", "partialclone extension"])(
    "prefetches missing blobs once from the %s and skips fetching local objects",
    async (remoteConfig) => {
      const { clone, commit, missing } = await partialClone();
      if (remoteConfig === "partialclone extension") {
        await git(clone, "config", "extensions.partialclone", "origin");
        await git(clone, "config", "--unset", "remote.origin.promisor");
      }
      const commandSpy = vi.spyOn(gitExec, "executeGitCommandBytes");
      const bufferedSpy = vi.spyOn(commandExec, "runCommandBuffered");
      const packetTrace = path.join(clone, "hydrate-packets.log");
      vi.stubEnv("GIT_TRACE_PACKET", packetTrace);
      const objectsBefore = new Set(
        (await git(clone, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")).split(
          "\n",
        ),
      );
      const configBefore = await fs.readFile(path.join(clone, ".git", "config"), "utf8");
      const refsBefore = await git(clone, "show-ref");
      const fetchHeadBefore = await fs.readFile(path.join(clone, ".git", "FETCH_HEAD"), "utf8");
      await expect(estimateWorktreeGitBytes(clone, commit)).resolves.toBe(16_384);
      const packets = await fs.readFile(packetTrace, "utf8");
      expect(packets).not.toMatch(/>\s+have [0-9a-f]{40}/u);
      expect(
        new Set([...packets.matchAll(/>\s+want ([0-9a-f]{40})/gu)].map((match) => match[1])),
      ).toEqual(new Set(missing));
      const objectsAfter = (
        await git(clone, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
      ).split("\n");
      expect(new Set(objectsAfter.filter((oid) => !objectsBefore.has(oid)))).toEqual(
        new Set(missing),
      );
      expect(await fs.readFile(path.join(clone, ".git", "config"), "utf8")).toBe(configBefore);
      expect(await git(clone, "show-ref")).toBe(refsBefore);
      expect(await fs.readFile(path.join(clone, ".git", "FETCH_HEAD"), "utf8")).toBe(
        fetchHeadBefore,
      );
      const fetches = commandSpy.mock.calls.filter(([, args]) => args[0] === "fetch");
      expect(fetches).toHaveLength(1);
      const fetchOptions = fetches[0]?.[2];
      expect(fetchOptions?.timeoutMs).toBe(300_000);
      const input = fetchOptions?.input;
      expect(
        typeof input === "string"
          ? input
          : input === undefined
            ? undefined
            : Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("utf8"),
      ).toBe(`${missing.join("\n")}\n`);
      expect(
        bufferedSpy.mock.calls.find(([argv]) => argv[0] === "git" && argv.includes("ls-tree"))?.[1]
          ?.env?.GIT_NO_LAZY_FETCH,
      ).toBe("1");
      commandSpy.mockClear();
      await expect(estimateWorktreeGitBytes(clone, commit)).resolves.toBe(16_384);
      expect(commandSpy.mock.calls.filter(([, args]) => args[0] === "fetch").length).toBe(0);
    },
  );

  it.each(["cancel", "revoke"] as const)(
    "keeps hydration behind queued ref writes and honors %s before fetching",
    async (action) => {
      const { clone, commit, missing } = await partialClone();
      const started = createDeferred();
      const release = createDeferred();
      const discovered = createDeferred();
      const held = gitExec.enqueueGitRefMutation(clone, ".git", async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      const execute = gitExec.executeGitCommandBytes;
      vi.spyOn(gitExec, "executeGitCommandBytes").mockImplementation(async (cwd, args, options) => {
        const result = await execute(cwd, args, options);
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          discovered.resolve();
        }
        return result;
      });
      const controller = new AbortController();
      const revoked = new Error("hydration authority revoked");
      let current = true;
      const pending = estimateWorktreeGitBytes(clone, commit, {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
      });
      try {
        await Promise.race([
          discovered.promise,
          pending.then(() => {
            throw new Error("hydration bypassed the queued ref writer");
          }),
        ]);
        for (const object of missing) {
          await expect(runGit(clone, ["cat-file", "-e", object])).resolves.toMatchObject({
            code: 1,
          });
        }
        const rejected = expect(pending).rejects.toThrow(revoked.message);
        if (action === "cancel") {
          controller.abort(revoked);
        } else {
          current = false;
        }
        release.resolve();
        await rejected;
        for (const object of missing) {
          await expect(runGit(clone, ["cat-file", "-e", object])).resolves.toMatchObject({
            code: 1,
          });
        }
      } finally {
        release.resolve();
        await Promise.allSettled([held, pending]);
      }
    },
  );

  it("hydrates both the source and destination when the overlay deletes missing source blobs", async () => {
    const { root, source, origin } = await partialClone();
    const base = await git(source, "rev-parse", "HEAD");
    await git(source, "rm", "base.txt", "large.txt");
    await git(source, "commit", "-m", "remove source blobs from overlay");
    await git(source, "push", origin, "main");
    const target = await git(source, "rev-parse", "HEAD");
    const clone = path.join(root, "without-checkout");
    await git(
      root,
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(origin).href,
      clone,
    );
    const deleted = await git(source, "rev-parse", `${base}:large.txt`);
    await expect(runGit(clone, ["cat-file", "-e", deleted])).resolves.toMatchObject({ code: 1 });

    await expect(estimateWorktreeCheckoutTransitionBytes(clone, base, target)).resolves.toEqual({
      targetBytes: 4096,
      changedBytes: 0,
      requiresFullCheckout: false,
    });

    await expect(runGit(clone, ["cat-file", "-e", deleted])).resolves.toMatchObject({ code: 0 });
    await expect(estimateWorktreeCheckoutTransitionBytes(clone, target, target)).resolves.toEqual({
      targetBytes: 4096,
      changedBytes: 0,
      requiresFullCheckout: false,
    });
  });

  it("recovers a transient missing-object fetch before estimating the checkout", async () => {
    const { clone, commit, missing } = await partialClone();
    const run = execRunner.runCommandBuffersWithTimeout;
    let attempts = 0;
    vi.spyOn(execRunner, "runCommandBuffersWithTimeout").mockImplementation((argv, options) => {
      if (argv.includes("fetch") && ++attempts === 1) {
        return Promise.resolve({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("error: origin did not send all necessary objects\n"),
          code: 1,
          signal: null,
          killed: false,
          termination: "exit",
          windowsEncoding: null,
        });
      }
      return run(argv, options);
    });

    await expect(estimateWorktreeGitBytes(clone, commit)).resolves.toBe(16_384);
    expect(attempts).toBe(2);
    for (const object of missing) {
      await expect(runGit(clone, ["cat-file", "-e", object])).resolves.toMatchObject({ code: 0 });
    }
  });

  it("budgets each changed destination path with raw names and without credit for source deletions", async () => {
    const { source } = await partialClone();
    const base = await git(source, "rev-parse", "HEAD");
    await git(source, "rm", "base.txt");
    await fs.writeFile(path.join(source, "small.txt"), "y".repeat(5000));
    await fs.writeFile(path.join(source, "copy-a.txt"), "same\n");
    await fs.writeFile(path.join(source, "copy-b.txt"), "same\n");
    const renamed = process.platform === "win32" ? "é space.txt" : "é space\nname.txt";
    await git(source, "mv", "large.txt", renamed);
    await git(source, "add", ".");
    await git(source, "commit", "-m", "overlay with duplicate blobs and unusual path");
    const target = await git(source, "rev-parse", "HEAD");

    await expect(estimateWorktreeCheckoutTransitionBytes(source, base, target)).resolves.toEqual({
      targetBytes: 24_576,
      changedBytes: 24_576,
      requiresFullCheckout: false,
    });
  });

  it.each([".gitattributes", "nested/.gitattributes"])(
    "budgets the full target when changing %s requires rematerializing unchanged files",
    async (attributesPath) => {
      const { source, commit } = await partialClone();
      await fs.mkdir(path.dirname(path.join(source, attributesPath)), { recursive: true });
      await fs.writeFile(path.join(source, attributesPath), "*.txt text eol=crlf\n");
      await git(source, "add", attributesPath);
      await git(source, "commit", "-m", "change checkout attributes");
      const target = await git(source, "rev-parse", "HEAD");

      await expect(
        estimateWorktreeCheckoutTransitionBytes(source, commit, target),
      ).resolves.toEqual({
        targetBytes: 20_480,
        changedBytes: 20_480,
        requiresFullCheckout: true,
      });
      await expect(
        estimateWorktreeCheckoutTransitionBytes(source, target, commit),
      ).resolves.toEqual({
        targetBytes: 16_384,
        changedBytes: 16_384,
        requiresFullCheckout: true,
      });
    },
  );

  it.each(["refs/replace/", "refs/size-replacements/"])(
    "does not reuse byte totals across effective replacements in %s",
    async (namespace) => {
      const { source, commit } = await partialClone();
      await expect(estimateWorktreeGitBytes(source, commit)).resolves.toBe(16_384);
      vi.stubEnv("GIT_REPLACE_REF_BASE", namespace);
      const original = await git(source, "rev-parse", `${commit}:base.txt`);
      const replacementPath = path.join(source, "replacement.txt");
      await fs.writeFile(replacementPath, "r".repeat(20_000));
      const replacement = await git(source, "hash-object", "-w", replacementPath);
      await git(source, "replace", original, replacement);

      await expect(estimateWorktreeGitBytes(source, commit)).resolves.toBe(32_768);
      await git(source, "replace", "-d", original);
      await expect(estimateWorktreeGitBytes(source, commit)).resolves.toBe(16_384);
    },
  );

  it("rejects newly missing objects even when the commit's byte total was already measured", async () => {
    const { source, commit } = await partialClone();
    await expect(estimateWorktreeGitBytes(source, commit)).resolves.toBe(16_384);
    const blob = await git(source, "rev-parse", `${commit}:large.txt`);
    await fs.unlink(path.join(source, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

    await expect(estimateWorktreeGitBytes(source, commit)).rejects.toThrow(
      `Repository is missing 1 objects for ${commit}; fetch or repair the clone.`,
    );
  });

  it("explains missing objects when no promisor remote can repair the clone", async () => {
    const { clone, commit } = await partialClone();
    await git(clone, "config", "--unset", "remote.origin.promisor");
    const commandSpy = vi.spyOn(gitExec, "executeGitCommandBytes");
    await expect(estimateWorktreeGitBytes(clone, commit)).rejects.toThrow(
      `Repository is missing 2 objects for ${commit}; fetch or repair the clone.`,
    );
    expect(commandSpy.mock.calls.filter(([, args]) => args[0] === "fetch").length).toBe(0);
  });
});
