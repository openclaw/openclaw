import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { threadId, Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { acquireFileLockSyncWithRetry } from "./file-lock-sync.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["live", "dead", "self", "legacy self", "other thread"])(
  "diagnoses or reclaims a %s handoff lock",
  async (holder) => {
    const { root } = await import("@openclaw/fs-safe/root");
    const directory = fs.realpathSync(dirs.make("handoff-lock-diagnostic-"));
    const target = path.join(directory, "managed-update-handoffs.sqlite");
    const lockPath = `${target}.lock`;
    const pid = holder === "live" ? process.ppid : holder === "dead" ? 2_147_483_647 : process.pid;
    const payload = {
      pid,
      starttime: getFileLockProcessStartTime(pid),
      command: "openclaw",
      phase: "doctor",
      ...(holder === "legacy self"
        ? {}
        : { threadId: holder === "other thread" ? threadId + 1 : threadId }),
    };
    fs.writeFileSync(lockPath, JSON.stringify(payload));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const options = {
        lockRoot: await root(directory),
        timeoutMs: 20,
        phase: "managed-handoff:writer-admission",
      };
      if (holder === "live" || holder === "other thread" || holder === "legacy self") {
        expect(() => acquireFileLockSyncWithRetry(target, options)).toThrow(
          expect.objectContaining({
            code: "file_lock_timeout",
            lockPath,
            timeoutMs: 20,
            phase: options.phase,
            holder: expect.objectContaining({ pid, alive: true, phase: "doctor" }),
            message: expect.stringMatching(
              /file_lock_timeout.*waited.*ms.*pid=.*alive=true.*doctor.*managed-handoff:writer-admission/,
            ),
          }),
        );
        expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(payload);
        expect(warning).not.toHaveBeenCalled();
      } else {
        const release = acquireFileLockSyncWithRetry(target, options);
        release();
        expect(fs.existsSync(lockPath)).toBe(false);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(`Reclaimed stale file lock ${lockPath}`),
        );
      }
    } finally {
      warning.mockRestore();
    }
  },
);

const writerSource = `
  const { parentPort, workerData } = require("node:worker_threads");
  (async () => {
    const { register } = await import(workerData.loader);
    register({ tsconfig: workerData.tsconfig });
    const { root } = await import(workerData.rootModule);
    const { acquireFileLockSyncWithRetry } = await import(workerData.lockModule);
    const lockRoot = await root(workerData.directory);
    if (workerData.holder) {
      const release = acquireFileLockSyncWithRetry(workerData.target, { lockRoot });
      parentPort.once("message", () => {
        try { release(); parentPort.postMessage({ phase: "released" }); }
        catch (error) { parentPort.postMessage({ phase: "failed", code: error.code }); }
        parentPort.close();
      });
      parentPort.postMessage({ phase: "held" });
      return;
    }
    const gate = new Int32Array(workerData.gate);
    const kill = process.kill;
    let observed = false;
    let expired = false;
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, "now", { value: () => now() + (expired ? 10_000 : 0) });
    process.kill = (pid, signal) => {
      const result = kill(pid, signal);
      if (!observed && pid === process.pid && signal === 0) {
        observed = true;
        parentPort.postMessage({ phase: "reclaim" });
        Atomics.wait(gate, 0, 0);
        expired = workerData.expire;
      }
      return result;
    };
    const release = acquireFileLockSyncWithRetry(workerData.target, {
      lockRoot, timeoutMs: 5_000,
    });
    release();
    parentPort.postMessage({ phase: "acquired" });
    parentPort.close();
  })().catch(error => {
    parentPort.postMessage({ phase: "failed", code: error.code, message: error.message });
    parentPort.close();
  });
`;

it.for([
  "release",
  "replacement inode",
  "foreign owner",
  "replaced root",
  "expired budget",
] as const)("preserves Root lock admission during reclaim: %s", async (transition, { signal }) => {
  const directory = fs.realpathSync(dirs.make("sync-lock-reclaim-"));
  const target = path.join(directory, "coordinator.sqlite");
  const lockPath = `${target}.lock`;
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const sidecarReplaced = transition === "replacement inode" || transition === "foreign owner";
  const foreign = Buffer.from(JSON.stringify({ pid: process.pid + 1, createdAt: "foreign" }));
  const launch = (holder: boolean) => {
    const worker = new Worker(writerSource, {
      eval: true,
      execArgv: [],
      workerData: {
        directory,
        target,
        holder,
        gate: gate.buffer,
        expire: transition === "expired budget",
        loader: import.meta.resolve("tsx/esm/api"),
        tsconfig: path.resolve("tsconfig.json"),
        rootModule: import.meta.resolve("@openclaw/fs-safe/root"),
        lockModule: pathToFileURL(path.resolve("src/infra/file-lock-sync.ts")).href,
      },
    });
    const exited = once(worker, "exit");
    void exited.catch(() => undefined);
    const next = () =>
      withinTest(
        awaitGateBeforeSettlement(once(worker, "message"), exited, "Lock worker exited"),
        signal,
      );
    return { worker, next, ready: next() };
  };
  const holder = launch(true);
  let contender: ReturnType<typeof launch> | undefined;
  try {
    expect((await holder.ready)[0]).toEqual({ phase: "held" });
    const original = fs.readFileSync(lockPath);
    contender = launch(false);
    expect((await contender.ready)[0]).toEqual({ phase: "reclaim" });
    const outcome = contender.next();
    if (!sidecarReplaced) {
      const released = holder.next();
      holder.worker.postMessage("release", []);
      expect((await released)[0]).toEqual({ phase: "released" });
      if (transition === "replaced root") {
        const retired = dirs.make("retired-sync-lock-root-");
        fs.rmdirSync(retired);
        fs.renameSync(directory, retired);
        fs.mkdirSync(directory);
      }
    } else if (transition === "replacement inode") {
      const replacement = `${target}.replacement`;
      fs.writeFileSync(replacement, original);
      fs.renameSync(replacement, lockPath);
    } else {
      fs.writeFileSync(lockPath, foreign);
    }
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const result = (await outcome)[0];
    if (transition === "release") {
      expect(result).toEqual({ phase: "acquired" });
    } else {
      expect(result).toMatchObject({
        phase: "failed",
        code: transition === "expired budget" ? "file_lock_timeout" : "path-mismatch",
      });
    }
    if (sidecarReplaced) {
      expect(fs.readFileSync(lockPath)).toEqual(
        transition === "replacement inode" ? original : foreign,
      );
    } else {
      expect(fs.existsSync(lockPath)).toBe(false);
    }
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await Promise.all([holder.worker.terminate(), contender?.worker.terminate()]);
  }
});
