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

  it.each(["never", "idempotent"] as const)(
    "bounds %s retry and preserves selected ports",
    async (transportRetry) => {
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const run = vi.fn(async (argv: string[], _options: CommandOptions) => {
        if (argv.at(-1)?.includes("command") && sshArgvPort(argv) === 2222) {
          if (transportRetry === "idempotent") {
            now += 175;
          }
          return result(255);
        }
        return result();
      });
      const actions = createWorkspaceActions(run);

      await expect(
        actions.runWorkspaceCommand({
          transportRetry,
          argv: ["printf", "command"],
          timeoutMs: transportRetry === "never" ? 777 : 1_000,
        }),
      ).resolves.toEqual(result(transportRetry === "never" ? 255 : 0));
      expect(
        run.mock.calls.map(([argv, options]) => [sshArgvPort(argv), options.timeoutMs]),
      ).toEqual(
        transportRetry === "never"
          ? [[2222, 777]]
          : [
              [2222, 1_000],
              [22, 825],
            ],
      );
      if (transportRetry === "idempotent") {
        expect(run.mock.calls[0]![1]).not.toBe(run.mock.calls[1]![1]);
      } else {
        await actions.runWorkspaceCommand({
          transportRetry: "idempotent",
          argv: ["printf", "selection-probe"],
        });
        expect(sshArgvPort(run.mock.calls[1]![0])).toBe(2222);
      }
    },
  );
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

  function interceptStat(file: string, inspect: () => void) {
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
      if (String(target) === file) {
        inspect();
      }
      return lstat(target, options);
    });
  }

  function pendingTransfer(active = true) {
    const completed = createDeferred<SpawnResult>();
    const state: { signal?: AbortSignal; settled: boolean } = { settled: false };
    const runTask = async (_argv: string[], { signal }: CommandOptions) => {
      state.signal = signal;
      signal?.addEventListener("abort", () => completed.reject(new Error("transfer cancelled")), {
        once: true,
      });
      return (active ? completed.promise : Promise.resolve(result())).finally(() => {
        state.settled = true;
      });
    };
    return { state, runTask, completed };
  }

  it.each(["active", "completed"] as const)(
    "tolerates a disappearing temporary manifest only during an active transfer (%s)",
    async (transferState) => {
      const destinationRoot = tempDirs.make("openclaw-rsync-manifest-rename-");
      const temporaryManifest = path.join(destinationRoot, ".manifest.json.partial");
      const finalManifest = path.join(destinationRoot, "manifest.json");
      await fs.writeFile(temporaryManifest, "manifest");
      const renamed = createDeferred();
      const { completed, state, runTask } = pendingTransfer(transferState === "active");
      interceptStat(temporaryManifest, () => {
        // Rsync publishes a listed temporary file before the quota walker stats it.
        fsSync.renameSync(temporaryManifest, finalManifest);
        renamed.resolve();
      });
      const outcome = transfer(destinationRoot, runTask).catch((error: unknown) => ({ error }));
      if (transferState === "active") {
        await vi.advanceTimersByTimeAsync(25);
        await renamed.promise;
        completed.resolve(result());
        await expect(outcome).resolves.toEqual(result());
      } else {
        await expect(outcome).resolves.toMatchObject({
          error: { code: "not-found", cause: { code: "ENOENT", path: temporaryManifest } },
        });
      }
      expect(state.signal?.aborted).toBe(false);
      await expect(fs.readFile(finalManifest, "utf8")).resolves.toBe("manifest");
    },
  );

  it.each(["scan", "quota"])(
    "aborts and joins a transfer before reporting %s failure",
    async (failure) => {
      const destinationRoot = tempDirs.make("openclaw-rsync-failure-");
      const file = path.join(destinationRoot, "manifest");
      await fs.writeFile(file, "over quota");
      const scanError = Object.assign(new Error("access denied"), { code: "EACCES" });
      if (failure === "scan") {
        interceptStat(file, () => {
          throw scanError;
        });
      }
      const { state, runTask } = pendingTransfer();
      const failed = expect(transfer(destinationRoot, runTask, { totalByteLimit: 1 })).rejects;
      const checked =
        failure === "scan" ? failed.toBe(scanError) : failed.toThrow("inbound transfer exceeds");
      await vi.advanceTimersByTimeAsync(25);
      await checked;
      expect(state).toMatchObject({ signal: { aborted: true }, settled: true });
    },
  );

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
