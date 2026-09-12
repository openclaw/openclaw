import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { enqueueGitRefMutation, gitNullConfigPath } from "./git-exec.js";
import { runGitWorkerOperation, type GitWorkerOperationOptions } from "./git-worker.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
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

async function exists(directory: string): Promise<number> {
  return fs.stat(directory).then(
    () => 1,
    (error: unknown) => {
      if (asOptionalRecord(error)?.code === "ENOENT") {
        return 0;
      }
      throw error;
    },
  );
}

async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Git worker lifecycle wait timed out")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Git operation host lifecycle", () => {
  it.each(["abort", "close"] as const)(
    "joins the real Git fetch before %s settles",
    async (ending) => {
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
          { signal: abort.signal },
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
        expect(Number(isPidAlive(gitPid))).toBe(1);
        if (ending === "abort") {
          abort.abort(new Error("fixture cancellation"));
        } else {
          await within(drainGlobalSingletonLifecycleState("restart"));
        }
        expect(Number((await within(pending)).rejected)).toBe(1);
        expect(Number(isPidAlive(gitPid))).toBe(0);
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
        expect(await exists(temporaryDirectory)).toBe(1);
        if (ending === "cancel") {
          abort.abort(new Error("snapshot cancelled"));
          await nextTurn();
          expect(completed).toBe(0);
          expect(await exists(temporaryDirectory)).toBe(1);
          release.resolve();
        }
        const result = await within(pending);
        expect(Number(result.rejected)).toBe(1);
        if (ending === "worker-error") {
          expect(
            Number(
              result.rejected &&
                result.error instanceof Error &&
                result.error.message.includes("provisioned path entered Git snapshot"),
            ),
          ).toBe(1);
        }
        expect(await exists(temporaryDirectory)).toBe(0);
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

  it.each(["authority", "HEAD"] as const)(
    "rechecks %s after the snapshot ref waits in the real mutation queue",
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
      const holder = enqueueGitRefMutation(repo, commonDir, async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const queueCalls = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
      const trace = path.join(root, "git-trace.jsonl");
      vi.stubEnv("GIT_TRACE2_EVENT", trace);
      let current = true;
      let temporaryDirectory = "";
      const revoked = new Error("snapshot authority revoked");
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
      try {
        await within(
          Promise.race([
            vi.waitFor(() => expect(queueCalls.mock.calls.length).toBe(1), { timeout: 10_000 }),
            pending.then(() => {
              throw new Error("Snapshot ended before its ref queued");
            }),
          ]),
        );
        expect(await exists(temporaryDirectory)).toBe(1);
        if (changed === "authority") {
          current = false;
        } else {
          await git(checkout, "add", "README.md");
          await git(checkout, "commit", "-m", "commit while snapshot publication waits");
          expectedHead = await git(checkout, "rev-parse", "HEAD");
        }
        release.resolve();
        await holder;
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
        expect(await exists(temporaryDirectory)).toBe(0);
      } finally {
        current = false;
        release.resolve();
        await holder;
        await pending;
      }
    },
  );
});
