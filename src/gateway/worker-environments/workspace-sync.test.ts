import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import type { PreparedWorkerSsh } from "./ssh.js";
import { sshArgvPort } from "./worker-ssh-argv.test-support.js";
import { runBoundedInboundRsync } from "./workspace-sync-helpers.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

afterEach(() => vi.restoreAllMocks());

function result(code = 0): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function createPreparedSsh(): PreparedWorkerSsh {
  let selectedPort = 2222;
  return {
    sshTarget: "worker@example.test",
    scpTarget: "worker@example.test",
    host: "example.test",
    advertisedPorts: [2222, 22],
    get port() {
      return selectedPort;
    },
    identityPath: "/identity",
    knownHostsPath: "/known-hosts",
    selectPort(port) {
      selectedPort = port;
    },
    dispose: async () => {},
  };
}

function createWorkspaceActions(
  run: (argv: string[], options: CommandOptions) => Promise<SpawnResult>,
  waitForPrepared?: () => Promise<PreparedWorkerSsh>,
) {
  const prepared = createPreparedSsh();
  return createWorkerWorkspaceActions({
    bundleHash: "a".repeat(64),
    environmentId: "worker:test",
    ownerSignal: new AbortController().signal,
    waitForPrepared: waitForPrepared ?? (async () => prepared),
    runner: { run },
    tasks: new Set(),
  });
}

describe("worker workspace command transport retry", () => {
  it.each(["never", "idempotent"] as const)(
    "does not dispatch a %s command after its turn closes during tunnel preparation",
    async (transportRetry) => {
      const run = vi.fn(async () => result());
      let current = true;
      const actions = createWorkspaceActions(run, async () => {
        await Promise.resolve();
        current = false;
        return createPreparedSsh();
      });
      await expect(
        actions.runWorkspaceCommand({
          argv: ["printf", "stale-attachment"],
          transportRetry,
          assertCurrent: () => {
            if (!current) {
              throw new Error("turn claim closed");
            }
          },
        }),
      ).rejects.toThrow("turn claim closed");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("runs never commands once without changing the selected port", async () => {
    // Pin the deadline so loaded runners still prove the exact dispatch budget.
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const run = vi.fn(async (argv: string[], _options: CommandOptions) =>
      argv.at(-1)?.includes("never-command") ? result(255) : result(),
    );
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "never",
        argv: ["printf", "never-command"],
        timeoutMs: 777,
      }),
    ).resolves.toMatchObject({ code: 255, termination: "exit" });
    expect(run).toHaveBeenCalledOnce();
    expect(sshArgvPort(run.mock.calls[0]![0])).toBe(2222);
    expect(run.mock.calls[0]![1].timeoutMs).toBe(777);

    await actions.runWorkspaceCommand({
      transportRetry: "idempotent",
      argv: ["printf", "selection-probe"],
    });
    expect(sshArgvPort(run.mock.calls[1]![0])).toBe(2222);
  });

  it("gives an idempotent fallback only the remaining operation timeout", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const run = vi.fn(async (argv: string[], _options: CommandOptions) => {
      if (sshArgvPort(argv) === 2222) {
        now += 175;
        return result(255);
      }
      return result();
    });
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "idempotent",
        argv: ["printf", "retry-with-deadline"],
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual(result());
    expect(run.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([1_000, 825]);
    expect(run.mock.calls[0]![1]).not.toBe(run.mock.calls[1]![1]);
  });
});

describe("bounded inbound workspace transfer", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function transfer(
    destinationRoot: string,
    runTask: Parameters<typeof runBoundedInboundRsync>[0]["runTask"],
    limits: { entryLimit?: number; totalByteLimit?: number } = {},
  ) {
    return runBoundedInboundRsync({
      argv: ["rsync"],
      destinationRoot,
      entryLimit: 10,
      totalByteLimit: 100,
      ownerSignal: new AbortController().signal,
      runTask,
      timeoutMs: 10_000,
      ...limits,
    });
  }

  it.each(["active", "completed"] as const)(
    "tolerates a disappearing temporary manifest only during an active transfer (%s)",
    async (transferState) => {
      const destinationRoot = tempDirs.make("openclaw-rsync-manifest-rename-");
      const temporaryManifest = path.join(destinationRoot, ".manifest.json.partial");
      const finalManifest = path.join(destinationRoot, "manifest.json");
      await fs.writeFile(temporaryManifest, "manifest");
      const renamed = createDeferred();
      const completed = createDeferred<SpawnResult>();
      const originalLstatSync = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
        if (String(target) === temporaryManifest) {
          // Rsync publishes a listed temporary file before the quota walker stats it.
          fsSync.renameSync(temporaryManifest, finalManifest);
          renamed.resolve();
        }
        return originalLstatSync(target, options);
      });
      let transferSignal: AbortSignal | undefined;
      const operation = transfer(destinationRoot, async (_argv, { signal }) => {
        transferSignal = signal;
        signal?.addEventListener("abort", () => completed.reject(signal.reason), { once: true });
        return transferState === "active" ? await completed.promise : result();
      });
      const outcome = operation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (transferState === "active") {
        await vi.advanceTimersByTimeAsync(25);
        await renamed.promise;
        completed.resolve(result());
        await expect(outcome).resolves.toEqual({ value: result() });
      } else {
        await expect(outcome).resolves.toMatchObject({
          error: { code: "not-found", cause: { code: "ENOENT", path: temporaryManifest } },
        });
      }
      expect(transferSignal?.aborted).toBe(false);
      await expect(fs.readFile(finalManifest, "utf8")).resolves.toBe("manifest");
    },
  );

  it("aborts and joins a transfer before reporting a failed directory scan", async () => {
    const destinationRoot = tempDirs.make("openclaw-rsync-scan-");
    const unreadable = path.join(destinationRoot, "unreadable");
    await fs.writeFile(unreadable, "manifest");
    const scanError = Object.assign(new Error("access denied"), { code: "EACCES" });
    const originalLstatSync = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
      if (String(target) === unreadable) {
        throw scanError;
      }
      return originalLstatSync(target, options);
    });
    let transferSignal: AbortSignal | undefined;
    let settled = false;
    const operation = transfer(destinationRoot, async (_argv, { signal }) => {
      transferSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      settled = true;
      throw new Error("transfer cancelled");
    });
    const failed = expect(operation).rejects.toBe(scanError);
    await vi.advanceTimersByTimeAsync(25);
    await failed;
    expect(transferSignal?.aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it("aborts an in-flight transfer when the destination crosses quota", async () => {
    const destinationRoot = tempDirs.make("openclaw-rsync-quota-");
    await fs.writeFile(path.join(destinationRoot, "oversized"), "over quota");
    let transferSignal: AbortSignal | undefined;
    const runTask = vi.fn(async (_argv: string[], options: CommandOptions) => {
      transferSignal = options.signal;
      return await new Promise<SpawnResult>((_resolve, reject) => {
        const abort = () => {
          const reason = options.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) {
          abort();
        }
      });
    });

    const failed = expect(
      transfer(destinationRoot, runTask, { totalByteLimit: 1 }),
    ).rejects.toThrow("inbound transfer exceeds");
    await vi.advanceTimersByTimeAsync(25);
    await failed;
    expect(transferSignal?.aborted).toBe(true);
  });

  it.each(["bytes", "entries"])(
    "rejects a completed transfer exceeding its %s quota",
    async (limit) => {
      const destinationRoot = tempDirs.make("openclaw-rsync-final-quota-");
      const runTask = async () => {
        await fs.writeFile(path.join(destinationRoot, "oversized"), "over quota");
        return result();
      };

      await expect(
        transfer(destinationRoot, runTask, {
          entryLimit: limit === "entries" ? 0 : 10,
          totalByteLimit: limit === "bytes" ? 1 : 100,
        }),
      ).rejects.toThrow("inbound transfer exceeds");
    },
  );
});
