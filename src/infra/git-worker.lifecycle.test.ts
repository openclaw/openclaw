import { execFile } from "node:child_process";
import nodeFs, { Dir } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeGitWorktreeOperation } from "../agents/worktrees/git-worktree-operations.runtime.js";
import * as worktreeGit from "../agents/worktrees/git.js";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../media/staged-inputs.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import * as gitExec from "./git-exec.js";
import * as gitWorkerContext from "./git-worker-context.js";
import { runGitWorkerOperation, type GitWorkerOperationOptions } from "./git-worker.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const supportsRawPathBytes = process.platform === "linux";

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function gitResult(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitExec.gitNullConfigPath(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_TRACE2_EVENT: undefined,
      GIT_NO_LAZY_FETCH: "1",
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "openclaw-test@example.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "openclaw-test@example.invalid",
    },
  }).then(
    ({ stdout }) => ({ code: 0, stdout: stdout.trim() }),
    (error: unknown) => ({ code: Number(asOptionalRecord(error)?.code) || -1, stdout: "" }),
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitResult(cwd, args);
  expect(result.code).toBe(0);
  return result.stdout;
}

async function repository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await git(root, "init", "--template=", "-b", "main", repo);
  await git(repo, "config", "commit.gpgSign", "false");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return repo;
}

async function partialClone(root: string) {
  const source = await repository(root);
  const origin = path.join(root, "origin.git");
  const clone = path.join(root, "clone");
  await git(root, "clone", "--bare", source, origin);
  await git(origin, "config", "uploadpack.allowFilter", "true");
  await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  await git(
    root,
    "clone",
    "--no-checkout",
    "--filter=blob:none",
    pathToFileURL(origin).href,
    clone,
  );
  const commit = await git(clone, "rev-parse", "HEAD");
  const objects = await git(
    clone,
    "rev-list",
    "--objects",
    "--missing=print",
    "--no-object-names",
    "--max-count=1",
    commit,
  );
  expect(objects.split("\n").filter((line) => line.startsWith("?")).length).toBe(1);
  return { clone, commit };
}

async function traceStarts(file: string, command: string) {
  const rows = (await fs.readFile(file, "utf8")).trim().split("\n");
  return rows.flatMap((line) => {
    const entry = asOptionalRecord(JSON.parse(line));
    return entry?.event === "start" && Array.isArray(entry.argv) && entry.argv.includes(command)
      ? [entry]
      : [];
  });
}

function settle<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ rejected: false as const, value }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
}

async function exists(directory: string): Promise<boolean> {
  return fs.stat(directory).then(
    () => true,
    (error: unknown) => {
      if (asOptionalRecord(error)?.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
}

async function within<T>(
  pending: Promise<T>,
  timeoutMessage = "Git worker lifecycle wait timed out",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Git operation host lifecycle", () => {
  it.each(["cleanup-inspection", "snapshot"] as const)(
    "bounds ignored dependency output during %s without losing private staged inputs",
    async (maintenance) => {
      const root = tempDirs.make("openclaw-ignored-inventory-");
      const repo = await repository(root);
      await fs.writeFile(path.join(repo, ".gitignore"), "dependencies/\nmedia/\nprivate.txt\n");
      await git(repo, "add", ".gitignore");
      await git(repo, "commit", "-m", "ignore generated and private files");
      const dependencies = path.join(repo, "dependencies", "package");
      await fs.mkdir(dependencies, { recursive: true });
      for (let index = 0; index < 64; index++) {
        await fs.writeFile(path.join(dependencies, `generated-dependency-file-${index}.txt`), "");
      }
      await fs.writeFile(path.join(repo, "private.txt"), "not snapshot-owned\n");
      const staged = stagedInputDirectory("c".repeat(64));
      await ensureStagedInputDirectory(repo, staged);
      const inputName = process.platform === "win32" ? "input note.txt" : "input\nnote.txt";
      const input = `${staged}/${inputName}`;
      await fs.writeFile(path.join(repo, input), "retain task input\n");
      await fs.mkdir(path.join(repo, "media", "project"));
      await fs.writeFile(path.join(repo, "media", "project", "private.txt"), "not owned\n");
      const realRun = worktreeGit.runGitBuffered;
      let ignoredReads = 0;
      vi.spyOn(worktreeGit, "runGitBuffered").mockImplementation(async (cwd, args, options) => {
        if (cwd === repo && args[0] === "ls-files" && args.includes("--ignored")) {
          ignoredReads++;
          return await realRun(cwd, args, { ...options, maxOutputBytes: 256 });
        }
        return await realRun(cwd, args, options);
      });
      if (maintenance === "cleanup-inspection") {
        expect(
          await runGitWorkerOperation({
            type: "worktree.cleanup-inspection",
            input: { kind: "nested-repository", checkoutPath: repo },
          }),
        ).toEqual({ retainedReason: undefined });
      } else {
        const snapshot = await runGitWorkerOperation(
          {
            type: "worktree.snapshot",
            input: {
              worktreeId: "bounded-ignored",
              checkoutPath: repo,
              repoRoot: repo,
              reason: "fixture",
              provisionedPaths: [],
            },
          },
          {
            onEffect: (effect) =>
              effect.type === "worktree.snapshot-provisioned" ? [] : undefined,
          },
        );
        expect(await git(repo, "show", `${snapshot.snapshotRef}:${input}`)).toBe(
          "retain task input",
        );
        const tree = await git(repo, "ls-tree", "-r", "--name-only", snapshot.snapshotRef);
        expect(tree).not.toContain("dependencies/");
        expect(tree).not.toContain("private.txt");
      }
      expect(ignoredReads).toBeGreaterThan(0);
    },
  );

  it.skipIf(!supportsRawPathBytes)(
    "inspects ignored raw-byte directories without following symlinks",
    async () => {
      const root = tempDirs.make("openclaw-ignored-directory-bytes-");
      const repo = await repository(root);
      await fs.writeFile(path.join(repo, ".gitignore"), "dependencies/\n");
      const dependencies = path.join(repo, "dependencies");
      await fs.mkdir(dependencies);
      const external = path.join(root, "external");
      await fs.mkdir(path.join(external, ".git"), { recursive: true });
      await fs.symlink(external, path.join(dependencies, "link"), "dir");
      const inspect = () =>
        runGitWorkerOperation({
          type: "worktree.cleanup-inspection",
          input: { kind: "nested-repository", checkoutPath: repo },
        });
      expect(await inspect()).toEqual({ retainedReason: undefined });
      const rawDirectory = Buffer.concat([Buffer.from(`${dependencies}/`), Buffer.from([0xff])]);
      await fs.mkdir(rawDirectory);
      await fs.symlink("missing-git-metadata", Buffer.concat([rawDirectory, Buffer.from("/.git")]));
      expect(await inspect()).toEqual({ retainedReason: "nested-repository" });
      await expect(
        runGitWorkerOperation(
          {
            type: "worktree.snapshot",
            input: {
              worktreeId: "raw-nested",
              checkoutPath: repo,
              repoRoot: repo,
              reason: "fixture",
              provisionedPaths: [],
            },
          },
          {
            onEffect: (effect) =>
              effect.type === "worktree.snapshot-provisioned" ? [] : undefined,
          },
        ),
      ).rejects.toThrow("nested git repositories cannot be snapshotted losslessly");
    },
  );

  it.skipIf(!supportsRawPathBytes).each(["cleanup-inspection", "snapshot"] as const)(
    "resolves unknown dirent types in ignored raw-byte directories during %s",
    async (maintenance) => {
      const root = tempDirs.make("openclaw-unknown-dirent-");
      const repo = await repository(root);
      await fs.writeFile(path.join(repo, ".gitignore"), "dependencies/\n");
      const rawDirectory = Buffer.concat([
        Buffer.from(`${repo}/dependencies/`),
        Buffer.from([0xff]),
      ]);
      const name = Buffer.concat([Buffer.from("ordinary-"), Buffer.from([0xfe])]);
      const child = Buffer.concat([rawDirectory, Buffer.from("/"), name]);
      await fs.mkdir(rawDirectory, { recursive: true });
      await fs.writeFile(child, "generated, not snapshot-owned\n");
      // Invoke the registered worktree dispatcher in-process so the low-level
      // fs.Dir fixture reaches the same inventory owner used by worker threads.
      const snapshotDirectory = path.join(root, "snapshot-index");
      await fs.mkdir(snapshotDirectory);
      vi.spyOn(gitWorkerContext, "requestGitWorkerEffect").mockImplementation(async (effect) => {
        switch (effect.type) {
          case "git.temporary-directory":
            return snapshotDirectory;
          case "worktree.snapshot-provisioned":
            return [];
          case "worktree.assert-current":
          case "worktree.snapshot-capacity":
            return undefined;
          default:
            throw new Error(`Unexpected worker effect: ${effect.type}`);
        }
      });
      const lstat = vi.spyOn(nodeFs, "lstatSync");
      const realOpen = fs.opendir;
      let reads = 0;
      const close = vi.fn((request: { oncomplete: (error: Error | null) => void }) => {
        request.oncomplete(null);
      });
      vi.spyOn(fs, "opendir").mockImplementation(async (directoryPath, options) => {
        if (!Buffer.isBuffer(directoryPath) || !directoryPath.equals(rawDirectory)) {
          return await realOpen(directoryPath, options);
        }
        // Only the low-level handle is fake: real fs.Dir performs getDirent's
        // UV_DIRENT_UNKNOWN (0) fallback, lstat, iteration, and handle closure.
        const handle = {
          read(
            encoding: string,
            _bufferSize: number,
            request: {
              oncomplete: (
                error: Error | null,
                entries: (Buffer | string | number)[] | null,
              ) => void;
            },
          ) {
            if (encoding !== "buffer" && !Buffer.isEncoding(encoding)) {
              throw new Error(`Unexpected directory encoding: ${encoding}`);
            }
            request.oncomplete(
              null,
              reads++ === 0 ? [encoding === "buffer" ? name : name.toString(encoding), 0] : null,
            );
          },
          close,
        };
        // Dir's public declaration omits its runtime constructor arguments.
        const directory: unknown = Reflect.construct(Dir, [handle, directoryPath, options]);
        if (!(directory instanceof Dir)) {
          throw new Error("Expected a real Node directory");
        }
        return directory;
      });
      if (maintenance === "cleanup-inspection") {
        expect(
          await executeGitWorktreeOperation({
            type: "worktree.cleanup-inspection",
            input: { kind: "nested-repository", checkoutPath: repo },
          }),
        ).toEqual({ retainedReason: undefined });
      } else {
        const snapshot = await executeGitWorktreeOperation({
          type: "worktree.snapshot",
          input: {
            worktreeId: "unknown-dirent",
            checkoutPath: repo,
            repoRoot: repo,
            reason: "fixture",
            provisionedPaths: [],
          },
        });
        if (typeof snapshot !== "object" || !("snapshotRef" in snapshot)) {
          throw new Error("Expected a worktree snapshot");
        }
        expect(await git(repo, "ls-tree", "-r", "--name-only", snapshot.snapshotRef)).not.toContain(
          "dependencies/",
        );
      }
      expect(reads).toBe(2);
      expect(lstat).toHaveBeenCalledWith(child);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("still refuses an ignored inventory exceeding the cap after directory collapsing", async () => {
    const root = tempDirs.make("openclaw-ignored-inventory-limit-");
    const repo = await repository(root);
    await fs.writeFile(path.join(repo, ".gitignore"), "*.ignored\n");
    for (let index = 0; index < 64; index++) {
      await fs.writeFile(path.join(repo, `private-file-${index}.ignored`), "");
    }
    const realRun = worktreeGit.runGitBuffered;
    vi.spyOn(worktreeGit, "runGitBuffered").mockImplementation(
      async (cwd, args, options) =>
        await realRun(
          cwd,
          args,
          cwd === repo && args[0] === "ls-files" && args.includes("--ignored")
            ? { ...options, maxOutputBytes: 256 }
            : options,
        ),
    );
    await expect(
      runGitWorkerOperation({
        type: "worktree.cleanup-inspection",
        input: { kind: "nested-repository", checkoutPath: repo },
      }),
    ).rejects.toThrow("output limit exceeded");
  });

  it("serves branch metadata while two independent diffs wait for Git", async () => {
    const root = tempDirs.make("openclaw-git-worker-read-priority-");
    const repo = await repository(root);
    const peerRoot = path.join(root, "peer");
    await fs.mkdir(peerRoot);
    const peer = await repository(peerRoot);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const realRun = worktreeGit.runGitBytes;
    vi.spyOn(worktreeGit, "runGitBytes").mockImplementation(async (cwd, args, options) => {
      if (
        (cwd === repo || cwd === peer) &&
        args.includes("--show-toplevel") &&
        args.at(-1) === "HEAD"
      ) {
        entered.resolve();
        await release.promise;
      }
      return await realRun(cwd, args, options);
    });
    const first = settle(
      runGitWorkerOperation({ type: "checkout.diff", input: { cwd: repo, scope: "uncommitted" } }),
    );
    const pending: Promise<unknown>[] = [first];
    try {
      await within(
        Promise.race([
          entered.promise,
          first.then(() => {
            throw new Error("Diff ended before its Git read was held");
          }),
        ]),
        "Diff did not reach its held Git request",
      );
      pending.push(
        settle(
          runGitWorkerOperation({
            type: "checkout.diff",
            input: { cwd: peer, scope: "uncommitted" },
          }),
        ),
      );
      const metadata = runGitWorkerOperation({
        type: "repository.branches",
        input: { repoRoot: repo },
      });
      pending.push(settle(metadata));
      const result = await within(
        metadata,
        "Branch metadata waited behind unrelated diff Git requests",
      );
      expect(result.branches).toContainEqual({ name: "main", kind: "local" });
    } finally {
      release.resolve();
      await Promise.all(pending);
    }
  });

  it.each(["cleanup-inspection", "snapshot"] as const)(
    "serves worktree preparation while %s waits for Git, without overlapping maintenance",
    async (maintenance) => {
      const root = tempDirs.make("openclaw-git-worker-worktree-priority-");
      const repo = await repository(root);
      const peerRoot = path.join(root, "peer");
      await fs.mkdir(peerRoot);
      const peer = await repository(peerRoot);
      await fs.writeFile(path.join(peer, ".gitignore"), "included.txt\n");
      await fs.writeFile(path.join(peer, ".worktreeinclude"), "included.txt\n");
      await fs.writeFile(path.join(peer, "included.txt"), "provisioned\n");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let heldRequests = 0;
      const realRun = worktreeGit.runGitBuffered;
      vi.spyOn(worktreeGit, "runGitBuffered").mockImplementation(async (cwd, args, options) => {
        if (cwd === repo && args[0] === "ls-files" && args.includes("--ignored")) {
          heldRequests++;
          entered.resolve();
          await release.promise;
        }
        return await realRun(cwd, args, options);
      });
      const startMaintenance = () =>
        runGitWorkerOperation(
          maintenance === "snapshot"
            ? {
                type: "worktree.snapshot",
                input: {
                  worktreeId: "held-maintenance",
                  checkoutPath: repo,
                  repoRoot: repo,
                  reason: "fixture",
                  provisionedPaths: [],
                },
              }
            : {
                type: "worktree.cleanup-inspection",
                input: { kind: "nested-repository", checkoutPath: repo },
              },
          {
            onEffect: (effect) =>
              effect.type === "worktree.snapshot-provisioned" ? [] : undefined,
          },
        );
      const first = settle(startMaintenance());
      const pending: Promise<unknown>[] = [first];
      try {
        await within(
          Promise.race([
            entered.promise,
            first.then(() => {
              throw new Error("Maintenance ended before its Git read was held");
            }),
          ]),
        );
        pending.push(settle(startMaintenance()));
        const preparation = Promise.all([
          runGitWorkerOperation({
            type: "worktree.git-size",
            input: { repoRoot: peer, ref: "HEAD" },
          }),
          runGitWorkerOperation({
            type: "worktree.provisioning-inspection",
            input: { sourceRoot: peer },
          }),
          runGitWorkerOperation({
            type: "worktree.checkout-transition-size",
            input: { repoRoot: peer, baseRef: "HEAD", targetRef: "HEAD" },
          }),
          runGitWorkerOperation({
            type: "worktree.directory-size",
            input: { root: peer, excludeGit: true },
          }),
        ]);
        pending.push(settle(preparation));
        const [gitBytes, provisioned, transition, directoryBytes] = await within(
          preparation,
          "Worktree preparation waited behind maintenance Git requests",
        );
        expect(gitBytes).toBe(4096);
        expect(provisioned).toEqual({ paths: ["included.txt"], estimatedBytes: 4096 });
        expect(transition).toEqual({
          targetBytes: 4096,
          changedBytes: 0,
          requiresFullCheckout: false,
        });
        expect(directoryBytes).toBe(43);
        expect(heldRequests).toBe(1);
      } finally {
        release.resolve();
        await Promise.all(pending);
      }
      expect(heldRequests).toBe(2);
      expect((await first).rejected).toBe(false);
    },
  );

  it.each([
    { ending: "abort", transport: "managed" },
    { ending: "close", transport: "managed" },
    { ending: "abort", transport: "caller" },
    { ending: "close", transport: "caller" },
  ] as const)(
    "joins the real Git fetch before $ending settles with $transport transport",
    async ({ ending, transport }) => {
      const root = tempDirs.make("openclaw-git-worker-child-");
      const { clone, commit } = await partialClone(root);
      const connected = createDeferredCore();
      const sockets = new Set<Socket>();
      let receivedBytes = 0;
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("data", (data) => {
          receivedBytes += data.length;
          connected.resolve();
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fixture listener address");
      }
      await git(clone, "remote", "set-url", "origin", `git://127.0.0.1:${address.port}/held.git`);
      const trace = path.join(root, "git-trace.jsonl");
      vi.stubEnv("GIT_TRACE2_EVENT", trace);
      const abort = new AbortController();
      const pending = settle(
        runGitWorkerOperation(
          { type: "worktree.git-size", input: { repoRoot: clone, ref: commit } },
          {
            signal: abort.signal,
            git:
              transport === "caller"
                ? {
                    text: gitExec.executeGitCommandBytes,
                    buffered: gitExec.executeGitCommandBuffered,
                  }
                : undefined,
          },
        ),
      );
      let gitPid: number | undefined;
      try {
        await within(
          Promise.race([
            connected.promise,
            pending.then(() => {
              throw new Error("Git operation ended before reaching the held transport");
            }),
          ]),
        );
        expect(receivedBytes).toBeGreaterThan(0);
        const starts = await traceStarts(trace, "fetch");
        expect(starts.length).toBe(1);
        const sid = starts[0]?.sid;
        const pidHex = typeof sid === "string" ? /-P([0-9a-f]+)$/iu.exec(sid)?.[1] : undefined;
        gitPid = Number.parseInt(pidHex ?? "", 16);
        expect(Number.isSafeInteger(gitPid)).toBe(true);
        expect(isPidAlive(gitPid)).toBe(true);
        if (ending === "abort") {
          abort.abort(new Error("fixture cancellation"));
        } else {
          await within(drainGlobalSingletonLifecycleState("restart"));
        }
        expect((await within(pending)).rejected).toBe(true);
        expect(isPidAlive(gitPid)).toBe(false);
        const next = await runGitWorkerOperation({
          type: "repository.branches",
          input: { repoRoot: clone },
        });
        expect(next.branches.length).toBeGreaterThan(0);
      } finally {
        abort.abort();
        for (const socket of sockets) {
          socket.destroy();
        }
        killPidIfAlive(gitPid);
        await pending;
        await drainGlobalSingletonLifecycleState();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each(["text", "buffered"] as const)(
    "captures caller %s policy before a queued sizing request can be changed",
    async (transport) => {
      const root = tempDirs.make("openclaw-caller-git-admission-");
      const repo = await repository(root);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let held = false;
      const first = settle(
        runGitWorkerOperation(
          { type: "worktree.git-size", input: { repoRoot: repo, ref: "HEAD" } },
          {
            git: {
              text: async (cwd, args, options) => {
                if (!held) {
                  held = true;
                  entered.resolve();
                  await release.promise;
                }
                return await gitExec.executeGitCommandBytes(cwd, args, options);
              },
              buffered: gitExec.executeGitCommandBuffered,
            },
          },
        ),
      );
      const pending: Promise<unknown>[] = [first];
      try {
        await within(
          Promise.race([
            entered.promise,
            first.then(() => {
              throw new Error("Sizing ended before the predecessor was held");
            }),
          ]),
        );
        const calls = { text: 0, buffered: 0 };
        const executors: NonNullable<GitWorkerOperationOptions["git"]> = {
          text: async (cwd, args, options) => {
            calls.text++;
            return await gitExec.executeGitCommandBytes(cwd, args, options);
          },
          buffered: async (cwd, args, options) => {
            calls.buffered++;
            return await gitExec.executeGitCommandBuffered(cwd, args, options);
          },
        };
        const second = settle(
          runGitWorkerOperation(
            { type: "worktree.git-size", input: { repoRoot: repo, ref: "HEAD" } },
            { git: executors },
          ),
        );
        pending.push(second);
        executors[transport] = async () => {
          throw new Error("queued caller replaced Git policy");
        };
        expect(calls).toEqual({ text: 0, buffered: 0 });
        release.resolve();
        expect(await within(first)).toEqual({ rejected: false, value: 4096 });
        expect(await within(second)).toEqual({ rejected: false, value: 4096 });
        expect(calls.text).toBeGreaterThan(0);
        expect(calls.buffered).toBeGreaterThan(0);
      } finally {
        release.resolve();
        await Promise.all(pending);
      }
    },
  );

  it.each(["text", "buffered"] as const)(
    "revalidates authority before caller %s execution and preserves the host error",
    async (transport) => {
      const root = tempDirs.make("openclaw-caller-git-authority-");
      const repo = await repository(root);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const revoked = new Error("caller Git authority revoked");
      let current = true;
      const trace = path.join(root, "git-trace.jsonl");
      vi.stubEnv("GIT_TRACE2_EVENT", trace);
      const waitForRevocation = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = settle(
        runGitWorkerOperation(
          { type: "worktree.git-size", input: { repoRoot: repo, ref: "HEAD" } },
          {
            assertCurrent: () => {
              if (!current) {
                throw revoked;
              }
            },
            git: {
              text: async (cwd, args, options) => {
                if (transport === "text") {
                  await waitForRevocation();
                }
                return await gitExec.executeGitCommandBytes(cwd, args, options);
              },
              buffered: async (cwd, args, options) => {
                if (transport === "buffered") {
                  await waitForRevocation();
                }
                return await gitExec.executeGitCommandBuffered(cwd, args, options);
              },
            },
          },
        ),
      );
      try {
        await within(
          Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Sizing ended before caller Git was held");
            }),
          ]),
        );
        current = false;
        release.resolve();
        const result = await within(pending);
        expect(result.rejected && result.error).toBe(revoked);
        const starts = (await exists(trace))
          ? await traceStarts(trace, transport === "text" ? "rev-parse" : "rev-list")
          : [];
        expect(starts).toHaveLength(0);
      } finally {
        current = false;
        release.resolve();
        await pending;
      }
    },
  );

  it.each(["worker-error", "cancel"] as const)(
    "removes only its snapshot temporary directory after %s",
    async (ending) => {
      const root = tempDirs.make("openclaw-git-worker-temporary-");
      const repo = await repository(root);
      const neighbor = path.join(root, "neighbor.txt");
      await fs.writeFile(neighbor, "keep");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const abort = new AbortController();
      let temporaryDirectory = "";
      const onEffect: NonNullable<GitWorkerOperationOptions["onEffect"]> = async (effect) => {
        if (
          effect.type === "worktree.snapshot-capacity" &&
          effect.input.purpose === "worktree safety snapshot index"
        ) {
          temporaryDirectory = effect.input.demands[0]?.path ?? "";
          entered.resolve();
          if (ending === "cancel") {
            await release.promise;
          }
        }
        if (effect.type === "worktree.snapshot-provisioned") {
          return [];
        }
        return undefined;
      };
      let completed = 0;
      const pending = settle(
        runGitWorkerOperation(
          {
            type: "worktree.snapshot",
            input: {
              worktreeId: "temporary-lifecycle",
              checkoutPath: repo,
              repoRoot: repo,
              reason: "fixture",
              // A provisioned path that became tracked must fail the worker's snapshot validation.
              provisionedPaths: ending === "worker-error" ? ["README.md"] : [],
            },
          },
          { signal: abort.signal, onEffect },
        ),
      ).then((result) => {
        completed++;
        return result;
      });
      try {
        await within(
          Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Snapshot ended before capacity inspection");
            }),
          ]),
        );
        expect(await exists(temporaryDirectory)).toBe(true);
        if (ending === "cancel") {
          abort.abort(new Error("snapshot cancelled"));
          await nextTurn();
          expect(completed).toBe(0);
          expect(await exists(temporaryDirectory)).toBe(true);
          release.resolve();
        }
        const result = await within(pending);
        expect(result.rejected).toBe(true);
        if (ending === "worker-error") {
          expect(
            result.rejected &&
              result.error instanceof Error &&
              result.error.message.includes("provisioned path entered Git snapshot"),
          ).toBe(true);
        }
        expect(await exists(temporaryDirectory)).toBe(false);
        expect((await fs.readFile(neighbor)).length).toBe(4);
        expect(
          (
            await gitResult(repo, [
              "show-ref",
              "--verify",
              "refs/openclaw/snapshots/temporary-lifecycle",
            ])
          ).code,
        ).not.toBe(0);
      } finally {
        release.resolve();
        abort.abort();
        await pending;
      }
    },
  );

  it.each(["authority", "HEAD", "abort", "restart"] as const)(
    "preserves the checkout when snapshot publication is interrupted by %s",
    async (changed) => {
      const root = tempDirs.make("openclaw-git-worker-authority-");
      const repo = await repository(root);
      const checkout = path.join(root, "worktree");
      await git(repo, "worktree", "add", "-b", "snapshot-source", checkout);
      await fs.writeFile(path.join(checkout, "README.md"), "dirty snapshot\n");
      let expectedHead = await git(checkout, "rev-parse", "HEAD");
      const commonDir = await git(repo, "rev-parse", "--git-common-dir");
      const held = createDeferredCore();
      const release = createDeferredCore();
      const order: string[] = [];
      const holder = gitExec.enqueueGitRefMutation(repo, commonDir, async () => {
        held.resolve();
        await release.promise;
        order.push("predecessor");
      });
      await held.promise;
      const queueCalls = vi.spyOn(gitExec, "enqueueGitRefMutation");
      const trace = path.join(root, "git-trace.jsonl");
      vi.stubEnv("GIT_TRACE2_EVENT", trace);
      let current = true;
      let temporaryDirectory = "";
      const revoked = new Error("snapshot authority revoked");
      const abort = new AbortController();
      const pending = settle(
        runGitWorkerOperation(
          {
            type: "worktree.snapshot",
            input: {
              worktreeId: "revoked-snapshot",
              checkoutPath: checkout,
              repoRoot: repo,
              reason: "fixture",
              provisionedPaths: [],
            },
          },
          {
            signal: abort.signal,
            assertCurrent: () => {
              if (!current) {
                throw revoked;
              }
            },
            onEffect: (effect) => {
              if (
                effect.type === "worktree.snapshot-capacity" &&
                effect.input.purpose === "worktree safety snapshot index"
              ) {
                temporaryDirectory = effect.input.demands[0]?.path ?? "";
              }
              if (effect.type === "worktree.snapshot-provisioned") {
                return [];
              }
              return undefined;
            },
          },
        ),
      );
      let successor: Promise<void> | undefined;
      try {
        await within(
          Promise.race([
            vi.waitFor(() => expect(queueCalls.mock.calls.length).toBe(1), { timeout: 10_000 }),
            pending.then(() => {
              throw new Error("Snapshot ended before its ref queued");
            }),
          ]),
        );
        expect(await exists(temporaryDirectory)).toBe(true);
        successor = gitExec.enqueueGitRefMutation(repo, commonDir, async () => {
          order.push("successor");
        });
        if (changed === "authority") {
          current = false;
        } else if (changed === "HEAD") {
          await git(checkout, "add", "README.md");
          await git(checkout, "commit", "-m", "commit while snapshot publication waits");
          expectedHead = await git(checkout, "rev-parse", "HEAD");
        } else {
          if (changed === "abort") {
            abort.abort(new Error("snapshot cancelled while queued"));
          } else {
            await within(drainGlobalSingletonLifecycleState("restart"));
          }
          const result = await within(pending, "Cancelled snapshot waited for another ref writer");
          expect(result.rejected).toBe(true);
          expect(await exists(temporaryDirectory)).toBe(false);
          expect(await traceStarts(trace, "update-ref")).toHaveLength(0);
          expect(order).toEqual([]);
        }
        release.resolve();
        await holder;
        await successor;
        expect(order).toEqual(["predecessor", "successor"]);
        const result = await within(pending);
        expect(result.rejected).toBe(true);
        if (changed === "authority") {
          expect(result.rejected && result.error).toBe(revoked);
          expect((await traceStarts(trace, "update-ref")).length).toBe(0);
        }
        expect(await git(checkout, "rev-parse", "HEAD")).toBe(expectedHead);
        expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe(
          "dirty snapshot\n",
        );
        expect(
          (
            await gitResult(repo, [
              "show-ref",
              "--verify",
              "refs/openclaw/snapshots/revoked-snapshot",
            ])
          ).code,
        ).not.toBe(0);
        expect(await exists(temporaryDirectory)).toBe(false);
      } finally {
        current = false;
        abort.abort();
        release.resolve();
        await holder;
        await successor;
        await pending;
      }
    },
  );
});
