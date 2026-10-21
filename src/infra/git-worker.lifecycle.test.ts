import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeGitWorktreeOperation } from "../agents/worktrees/git-worktree-operations.runtime.js";
import * as worktreeGit from "../agents/worktrees/git.js";
import { runPublicationCommand } from "../gateway/github-publication-git-transport.js";
import { runWorkspaceInventoryCommandToFile } from "../gateway/worker-environments/workspace-sync-inventory.js";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../media/staged-inputs.js";
import { emitChildProcessSpawnSample } from "../process/spawn-diagnostics.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import * as gitExec from "./git-exec.js";
import { installUnknownDirentFixture } from "./git-worker-dir.test-support.js";
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

async function fixture(prefix: string) {
  const root = tempDirs.make(`openclaw-${prefix}-`);
  return { root, repo: await repository(root) };
}

const inspect = (checkoutPath: string, options?: GitWorkerOperationOptions) =>
  runGitWorkerOperation(
    { type: "worktree.cleanup-inspection", input: { kind: "nested-repository", checkoutPath } },
    options,
  );
const size = (repoRoot: string, options?: GitWorkerOperationOptions, ref = "HEAD") =>
  runGitWorkerOperation({ type: "worktree.git-size", input: { repoRoot, ref } }, options);
const snapshot = (
  repoRoot: string,
  worktreeId: string,
  options: GitWorkerOperationOptions = { onEffect: () => undefined },
  checkoutPath = repoRoot,
  provisionedPaths: string[] = [],
) =>
  runGitWorkerOperation(
    {
      type: "worktree.snapshot",
      input: { worktreeId, checkoutPath, repoRoot, reason: "fixture", provisionedPaths },
    },
    options,
  );
const snapshotRefExists = async (repo: string, id: string) =>
  (await gitResult(repo, ["show-ref", "--verify", `refs/openclaw/snapshots/${id}`])).code === 0;

function callerGit(before: (transport: "text" | "buffered") => void | Promise<void>) {
  return {
    text: async (...args: Parameters<typeof gitExec.executeGitCommandBytes>) => {
      await before("text");
      return gitExec.executeGitCommandBytes(...args);
    },
    buffered: async (...args: Parameters<typeof gitExec.executeGitCommandBuffered>) => {
      await before("buffered");
      return gitExec.executeGitCommandBuffered(...args);
    },
  };
}

function traceGit(root: string) {
  const file = path.join(root, "git-trace.jsonl");
  vi.stubEnv("GIT_TRACE2_EVENT", file);
  return file;
}

function snapshotCapacity(observe: (directory: string) => void | Promise<void>) {
  return (effect: Parameters<NonNullable<GitWorkerOperationOptions["onEffect"]>>[0]) => {
    if (
      effect.type === "worktree.snapshot-capacity" &&
      effect.input.purpose === "worktree safety snapshot index"
    ) {
      return observe(effect.input.demands[0]?.path ?? "");
    }
  };
}

function limitIgnoredOutput(repo: string) {
  const realRun = worktreeGit.runGitBuffered;
  let reads = 0;
  vi.spyOn(worktreeGit, "runGitBuffered").mockImplementation(async (cwd, args, options) => {
    const ignored = cwd === repo && args[0] === "ls-files" && args.includes("--ignored");
    if (ignored) {
      reads++;
    }
    return realRun(cwd, args, ignored ? { ...options, maxOutputBytes: 256 } : options);
  });
  return () => reads;
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

function within<T>(
  pending: Promise<T>,
  timeoutMessage = "Git worker lifecycle wait timed out",
): Promise<T> {
  return withTestTimeout(pending, 10_000, timeoutMessage);
}

function waitForLifecyclePoint(
  reached: Promise<unknown>,
  operation: Promise<unknown>,
  endedMessage: string,
  timeoutMessage?: string,
) {
  return within(awaitGateBeforeSettlement(reached, operation, endedMessage), timeoutMessage);
}

describe("Git operation host lifecycle", () => {
  it("inspections never hydrate missing blobs across Git adapters", async () => {
    const adapters = [
      ["text", gitExec.executeGitCommand],
      ["bytes", gitExec.executeGitCommandBytes],
      ["buffered", gitExec.executeGitCommandBuffered],
      ["worktree text", worktreeGit.runGit],
      ["worktree bytes", worktreeGit.runGitBytes],
      ["worktree buffered", worktreeGit.runGitBuffered],
      [
        "publication",
        (cwd: string, args: string[]) => runPublicationCommand(["git", "-C", cwd, ...args]),
      ],
      [
        "inventory",
        async (cwd: string, args: string[]) => {
          try {
            await runWorkspaceInventoryCommandToFile({
              argv: ["git", "-C", cwd, ...args],
              outputPath: path.join(cwd, "inventory.out"),
              signal: new AbortController().signal,
              timeoutMs: 5_000,
              baseEnv: { ...process.env },
            });
            return { code: 0 };
          } catch {
            return { code: 128 };
          }
        },
      ],
    ] as const;
    const root = tempDirs.make("openclaw-git-read-partial-clone-");
    const { clone, commit } = await partialClone(root);
    const packDirectory = path.join(clone, ".git", "objects", "pack");
    const before = (await fs.readdir(packDirectory)).toSorted();
    // A caller's inherited opt-in cannot turn background reads into transfers.
    vi.stubEnv("GIT_NO_LAZY_FETCH", "0");
    const trace = traceGit(root);
    for (const [name, run] of adapters) {
      const outcome = await run(clone, [
        "-c",
        "core.fsmonitor=false",
        "show",
        `${commit}:README.md`,
      ]);
      expect(outcome.code, name).not.toBe(0);
      expect(await traceStarts(trace, "fetch"), name).toHaveLength(0);
      expect((await fs.readdir(packDirectory)).toSorted(), name).toEqual(before);
    }

    // Explicit object transfers still work; every reader then succeeds.
    const blob = await git(clone, "rev-parse", `${commit}:README.md`);
    await worktreeGit.requireGit(clone, ["fetch", "--no-auto-maintenance", "origin", blob]);
    await fs.rm(path.join(clone, "inventory.out"));
    for (const [name, run] of adapters) {
      expect((await run(clone, ["show", `${commit}:README.md`])).code, name).toBe(0);
    }
    expect((await fs.readdir(packDirectory)).filter((name) => name.endsWith(".pack"))).toHaveLength(
      2,
    );
  });

  it("uses local PR statistics when Git supports disabling lazy fetches", async () => {
    const root = tempDirs.make("openclaw-pr-facts-partial-clone-");
    const localOnly = (await gitResult(root, ["--no-lazy-fetch", "version"])).code === 0;
    const { clone, commit } = await partialClone(root);
    const blob = await git(clone, "rev-parse", `${commit}:README.md`);
    await git(clone, "read-tree", commit);
    const feature = await git(
      clone,
      "commit-tree",
      `${commit}^{tree}`,
      "-p",
      commit,
      "-m",
      "feature",
    );
    await git(clone, "update-ref", "refs/heads/feature", feature);
    await git(clone, "symbolic-ref", "HEAD", "refs/heads/feature");
    await git(clone, "update-ref", "refs/remotes/origin/feature", feature);
    // Same-size dirty content also exercises Git's stat-unmatch refresh path.
    await fs.writeFile(path.join(clone, "README.md"), "work\n");
    const trace = traceGit(root);
    const readFacts = async () =>
      runGitWorkerOperation({
        type: "pull-request.branch-facts",
        input: {
          root: clone,
          branch: "feature",
          defaultBranch: "main",
          mergedHeads: [],
          refreshIndex: true,
          comparison: await runGitWorkerOperation({
            type: "pull-request.branch-comparison",
            input: { root: clone, branch: "feature", defaultBranch: "main", mergedHeads: [] },
          }),
        },
      });

    const stats = { additions: 1, deletions: 1, changedFiles: 1 };
    expect(await readFacts()).toEqual({ creatable: true, stats: localOnly ? null : stats });
    expect(await traceStarts(trace, "fetch")).toHaveLength(localOnly ? 0 : 1);

    await git(clone, "fetch", "--no-tags", "--no-write-fetch-head", "origin", blob);
    expect(await readFacts()).toEqual({
      creatable: true,
      stats,
    });
    expect(await traceStarts(trace, "fetch")).toHaveLength(localOnly ? 0 : 1);
  });

  it("bounds ignored dependency output during snapshot without losing private staged inputs", async () => {
    const { repo } = await fixture("ignored-inventory");
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
    const ignoredReads = limitIgnoredOutput(repo);
    const result = await snapshot(repo, "bounded-ignored");
    expect(await git(repo, "show", `${result.snapshotRef}:${input}`)).toBe("retain task input");
    const tree = await git(repo, "ls-tree", "-r", "--name-only", result.snapshotRef);
    expect(tree).not.toContain("dependencies/");
    expect(tree).not.toContain("private.txt");
    expect(ignoredReads()).toBeGreaterThan(0);
  });

  it.skipIf(!supportsRawPathBytes)(
    "inspects ignored raw-byte directories without following symlinks",
    async () => {
      const { root, repo } = await fixture("ignored-directory-bytes");
      await fs.writeFile(path.join(repo, ".gitignore"), "dependencies/\n");
      const dependencies = path.join(repo, "dependencies");
      await fs.mkdir(dependencies);
      const external = path.join(root, "external");
      await fs.mkdir(path.join(external, ".git"), { recursive: true });
      await fs.symlink(external, path.join(dependencies, "link"), "dir");
      expect(await inspect(repo)).toEqual({ retainedReason: undefined });
      const rawDirectory = Buffer.concat([Buffer.from(`${dependencies}/`), Buffer.from([0xff])]);
      await fs.mkdir(rawDirectory);
      await fs.symlink("missing-git-metadata", Buffer.concat([rawDirectory, Buffer.from("/.git")]));
      expect(await inspect(repo)).toEqual({ retainedReason: "nested-repository" });
      await expect(snapshot(repo, "raw-nested")).rejects.toThrow(
        "nested git repositories cannot be snapshotted losslessly",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves unknown dirent types through runtime fixtures during cleanup inspection",
    async () => {
      const { repo } = await fixture("unknown-dirent");
      await fs.writeFile(path.join(repo, ".gitignore"), "dependencies/\n");
      const rawDirectory = Buffer.concat([
        Buffer.from(`${repo}/dependencies/`),
        supportsRawPathBytes ? Buffer.from([0xff]) : Buffer.from("界"),
      ]);
      const name = Buffer.concat([
        Buffer.from("ordinary-"),
        supportsRawPathBytes ? Buffer.from([0xfe]) : Buffer.from("文"),
      ]);
      const child = Buffer.concat([rawDirectory, Buffer.from("/"), name]);
      await fs.mkdir(rawDirectory, { recursive: true });
      await fs.writeFile(child, "generated, not snapshot-owned\n");
      // Observe the directory API at the inventory owner used by workers.
      const directoryFixture = installUnknownDirentFixture(rawDirectory, name);
      expect(
        await executeGitWorktreeOperation({
          type: "worktree.cleanup-inspection",
          input: { kind: "nested-repository", checkoutPath: repo },
        }),
      ).toEqual({ retainedReason: undefined });
      directoryFixture.expectConsumed(child);
    },
  );

  it("still refuses an ignored inventory exceeding the cap after directory collapsing", async () => {
    const { repo } = await fixture("ignored-inventory-limit");
    await fs.writeFile(path.join(repo, ".gitignore"), "*.ignored\n");
    for (let index = 0; index < 64; index++) {
      await fs.writeFile(path.join(repo, `private-file-${index}.ignored`), "");
    }
    limitIgnoredOutput(repo);
    await expect(inspect(repo)).rejects.toThrow("output limit exceeded");
  });

  it("serves branch metadata while two independent diffs wait for Git", async () => {
    const { root, repo } = await fixture("git-worker-read-priority");
    const peerRoot = path.join(root, "peer");
    await fs.mkdir(peerRoot);
    const peer = await repository(peerRoot);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    const spawns: Extract<DiagnosticEventPayload, { type: "diagnostic.child_process.spawn" }>[] =
      [];
    const stop = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.child_process.spawn") {
        spawns.push(event);
      }
    });
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
      await waitForLifecyclePoint(
        entered.promise,
        first,
        "Diff ended before its Git read was held",
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
      now = 60_000;
      emitChildProcessSpawnSample();
      stop();
      setDiagnosticsEnabledForProcess(false);
      emitChildProcessSpawnSample();
    }
    expect(
      spawns
        .map(({ operation }) => operation ?? "unknown")
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["checkout.diff", "repository.branches"]);
    expect(spawns.every(({ family, count }) => family === "git" && count > 0)).toBe(true);
  });

  it.each(["cleanup-inspection", "snapshot"] as const)(
    "serves worktree preparation while %s waits for Git, without overlapping maintenance",
    async (maintenance) => {
      const { root, repo } = await fixture("git-worker-worktree-priority");
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
        maintenance === "snapshot"
          ? snapshot(repo, "held-maintenance")
          : inspect(repo, { onEffect: () => undefined });
      const first = settle(startMaintenance());
      const pending: Promise<unknown>[] = [first];
      try {
        await waitForLifecyclePoint(
          entered.promise,
          first,
          "Maintenance ended before its Git read was held",
        );
        pending.push(settle(startMaintenance()));
        const preparation = Promise.all([
          size(peer),
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
            input: { root: peer },
          }),
          runGitWorkerOperation({
            type: "worktree.eviction-source",
            input: {
              sourceRoot: peer,
              commonDir: path.join(peer, ".git"),
              requiredPaths: [],
              records: [{ id: "preparation-source", path: peer, repoRoot: peer }],
            },
          }),
        ]);
        pending.push(settle(preparation));
        const [gitBytes, provisioned, transition, directoryBytes, source] = await within(
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
        expect(source).toMatchObject({ worktreeIds: ["preparation-source"], complete: true });
        expect(source.ownedPaths).toContainEqual({ id: "preparation-source", path: peer });
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
      const trace = traceGit(root);
      const abort = new AbortController();
      const pending = settle(
        size(
          clone,
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
          commit,
        ),
      );
      let gitPid: number | undefined;
      try {
        await waitForLifecyclePoint(
          connected.promise,
          pending,
          "Git operation ended before reaching the held transport",
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

  it("captures caller Git policy before a queued sizing request can be changed", async () => {
    const { repo } = await fixture("caller-git-admission");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let held = false;
    const first = settle(
      size(repo, {
        git: callerGit(async (transport) => {
          if (transport === "text" && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
        }),
      }),
    );
    const pending: Promise<unknown>[] = [first];
    try {
      await waitForLifecyclePoint(
        entered.promise,
        first,
        "Sizing ended before the predecessor was held",
      );
      const calls = { text: 0, buffered: 0 };
      const executors = callerGit((transport) => {
        calls[transport]++;
      });
      const second = settle(size(repo, { git: executors }));
      pending.push(second);
      executors.text = executors.buffered = async () => {
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
  });

  it.each(["text", "buffered"] as const)(
    "revalidates authority before caller %s execution and preserves the host error",
    async (transport) => {
      const { root, repo } = await fixture("caller-git-authority");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const revoked = new Error("caller Git authority revoked");
      let current = true;
      const trace = traceGit(root);
      const pending = settle(
        size(repo, {
          assertCurrent: () => {
            if (!current) {
              throw revoked;
            }
          },
          git: callerGit(async (kind) => {
            if (kind === transport) {
              entered.resolve();
              await release.promise;
            }
          }),
        }),
      );
      try {
        await waitForLifecyclePoint(
          entered.promise,
          pending,
          "Sizing ended before caller Git was held",
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
      const { root, repo } = await fixture("git-worker-temporary");
      const neighbor = path.join(root, "neighbor.txt");
      await fs.writeFile(neighbor, "keep");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const abort = new AbortController();
      let temporaryDirectory = "";
      const onEffect = snapshotCapacity(async (directory) => {
        temporaryDirectory = directory;
        entered.resolve();
        if (ending === "cancel") {
          await release.promise;
        }
      });
      let completed = 0;
      const pending = settle(
        snapshot(
          repo,
          "temporary-lifecycle",
          { signal: abort.signal, onEffect },
          repo,
          // A provisioned path that became tracked must fail snapshot validation.
          ending === "worker-error" ? ["README.md"] : [],
        ),
      ).then((result) => {
        completed++;
        return result;
      });
      try {
        await waitForLifecyclePoint(
          entered.promise,
          pending,
          "Snapshot ended before capacity inspection",
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
          expect(result.rejected && result.error).toMatchObject({
            message: "provisioned path is now tracked: README.md",
          });
        }
        expect(await exists(temporaryDirectory)).toBe(false);
        expect((await fs.readFile(neighbor)).length).toBe(4);
        expect(await snapshotRefExists(repo, "temporary-lifecycle")).toBe(false);
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
      const { root, repo } = await fixture("git-worker-authority");
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
      const trace = traceGit(root);
      let current = true;
      let temporaryDirectory = "";
      const revoked = new Error("snapshot authority revoked");
      const abort = new AbortController();
      const pending = settle(
        snapshot(
          repo,
          "revoked-snapshot",
          {
            signal: abort.signal,
            assertCurrent: () => {
              if (!current) {
                throw revoked;
              }
            },
            onEffect: snapshotCapacity((directory) => {
              temporaryDirectory = directory;
            }),
          },
          checkout,
        ),
      );
      let successor: Promise<void> | undefined;
      try {
        await waitForLifecyclePoint(
          vi.waitFor(() => expect(queueCalls.mock.calls.length).toBe(1), { timeout: 10_000 }),
          pending,
          "Snapshot ended before its ref queued",
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
        expect(await snapshotRefExists(repo, "revoked-snapshot")).toBe(false);
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
