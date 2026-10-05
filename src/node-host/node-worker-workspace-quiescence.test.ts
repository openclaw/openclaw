import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ProcessSupervisor, RunExit } from "../process/supervisor/types.js";
import type { NodeWorkerWorkspaceQuiescenceInput } from "../worker/node-workspace-protocol.js";
import { NodeWorkerWorkspaceQuiescence } from "./node-worker-workspace-quiescence.js";

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn<() => Promise<void>>(async () => {}),
  acquire: vi.fn<ProcessSupervisor["acquireScopeCleanup"]>(),
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  helper: vi.fn<typeof import("node:child_process").spawn>(),
  live: new Set<number>(),
}));
vi.mock("../process/supervisor/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/supervisor/index.js")>()),
  getProcessSupervisor: () => ({ acquireScopeCleanup: mocks.acquire, spawn: mocks.spawn }),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.helper,
}));
vi.mock("./node-worker-process-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-worker-process-identity.js")>()),
  requireNodeWorkerProcessIdentity: (pid: number) => ({ pid, startTime: pid }),
  inspectNodeWorkerProcessIdentity: ({ pid }: { pid: number }) =>
    mocks.live.has(pid) ? "live" : "dead",
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  mocks.acquire.mockImplementation(() => mocks.cleanup);
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  mocks.live.clear();
  vi.resetAllMocks();
});
const nonce = "a".repeat(32);
const acquire = { action: "acquire", nonce, timeoutMs: 30_000 } as const;
const renew = { action: "renew", nonce, timeoutMs: 30_000, validationMode: "final" } as const;
const release = { action: "release", nonce } as const;

function fixture() {
  const home = fs.realpathSync(tempDirs.make("node-quiescence-controller-"));
  const workspaceDir = path.join(home, "workspace");
  fs.mkdirSync(workspaceDir);
  const releaseWorkspace = vi.fn();
  const owner = new NodeWorkerWorkspaceQuiescence();
  const children: ChildProcess[] = [];
  const exits = new Map<ChildProcess, () => void>();
  const execute = (operation: NodeWorkerWorkspaceQuiescenceInput, signal?: AbortSignal) =>
    owner.execute(
      {
        input: {
          gatewayNamespace: "gateway-one",
          environmentId: "environment-one",
          sessionId: "session-one",
          generation: 1,
          argv: ["openclaw-internal-workspace-quiescence", workspaceDir],
          quiescence: operation,
        },
        workspaceDir,
        env: { HOME: home, USERPROFILE: home },
        retainWorkspace: () => releaseWorkspace,
      },
      signal,
    );
  const readLease = () => {
    const database = new DatabaseSync(
      path.join(home, ".openclaw-worker", "quiescence", "windows-shared-host.sqlite"),
      { readOnly: true },
    );
    try {
      const row = database
        .prepare("SELECT lease_json FROM workspace_leases WHERE workspace_key = ?")
        .get(createHash("sha256").update(workspaceDir).digest("hex"));
      return row ? JSON.parse(String(row.lease_json)) : undefined;
    } finally {
      database.close();
    }
  };

  // Execute the generated program, including its real SQLite transactions and IPC
  // receipts. Only the OS transport and expiry clock are simulated on Linux CI.
  const script = (args: readonly string[], child?: ChildProcess) => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const exited = new Error("script exited");
    const pid = child?.pid ?? 9000;
    const finish = (code: number) => {
      exitCode = code;
      if (child && mocks.live.delete(pid)) {
        Object.defineProperties(child, {
          connected: { configurable: true, value: false },
          exitCode: { configurable: true, value: code },
        });
        queueMicrotask(() => child.emit("close", code, null));
      }
    };
    const guest = Object.assign(new EventEmitter(), {
      argv: [process.execPath, ...args.slice(2)],
      platform: "win32",
      pid,
      execPath: process.execPath,
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
      send: (message: unknown) => queueMicrotask(() => child?.emit("message", message)),
      exit: (code: number) => {
        finish(code);
        throw exited;
      },
    });
    Object.defineProperty(guest, "connected", {
      get: () => child?.connected ?? false,
    });
    if (child) {
      exits.set(child, () => finish(1));
      Object.defineProperty(child, "send", {
        value: (message: unknown, callback?: (error: Error | null) => void) => {
          queueMicrotask(() => {
            try {
              guest.emit("message", message);
              callback?.(null);
            } catch (error) {
              if (error !== exited) {
                throw error;
              }
            }
          });
          return true;
        },
      });
    }
    try {
      runInNewContext(args[1]!, {
        process: guest,
        require: (name: string) => {
          if (name === "node:os") {
            return { homedir: () => home };
          }
          if (name === "node:child_process") {
            return {};
          }
          return require(name);
        },
        setTimeout: () => 1,
        clearTimeout: () => {},
        performance,
      });
    } catch (error) {
      if (error !== exited) {
        stderr += String(error);
        finish(1);
      }
    }
    return { stdout, stderr, exitCode };
  };
  mocks.helper.mockImplementation((_command, args) => {
    if (!Array.isArray(args)) {
      throw new Error("expected helper argv");
    }
    const child = new ChildProcess();
    const pid = 1000 + children.length;
    Object.defineProperties(child, {
      pid: { value: pid },
      connected: { configurable: true, value: true },
    });
    children.push(child);
    mocks.live.add(pid);
    queueMicrotask(() => script(args, child));
    return child;
  });
  mocks.spawn.mockImplementation(async (input) => {
    if (input.mode !== "child") {
      throw new Error("expected standalone recovery command");
    }
    const outcome = script(input.argv.slice(1));
    const result: RunExit = {
      ...outcome,
      reason: "exit",
      exitSignal: null,
      durationMs: 0,
      timedOut: false,
      noOutputTimedOut: false,
    };
    return {
      activity: { resultSettled: true, lastOutputAtMs: 0 },
      runId: input.runId ?? "recovery",
      startedAtMs: 0,
      wait: async () => result,
      cancel: () => {},
    };
  });
  return {
    owner,
    execute,
    readLease,
    releaseWorkspace,
    children,
    kill: async () => {
      const child = children.at(-1)!;
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      exits.get(child)!();
      await closed;
    },
  };
}

describe("Windows-selected quiescence controller contracts", () => {
  it("reuses the retained helper across SQLite leases while fencing stale nonces", async () => {
    const f = fixture();
    try {
      await expect(f.execute(acquire)).resolves.toBe("quiesced " + nonce + "\n");
      expect(mocks.helper).toHaveBeenCalledOnce();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(f.readLease()).toMatchObject({
        nonce,
        sharedHost: true,
        processes: [],
        watchdog: null,
      });
      expect(f.releaseWorkspace).not.toHaveBeenCalled();
      await expect(f.execute(renew)).resolves.toBe("renewed " + nonce + "\n");
      await f.execute(release);
      expect(f.readLease()).toBeUndefined();
      const nextNonce = "b".repeat(32);
      await f.execute({ ...acquire, nonce: nextNonce });
      for (const operation of [acquire, renew, release]) {
        await expect(f.execute(operation)).rejects.toThrow(/already active|no longer active/);
      }
      expect(f.readLease()).toMatchObject({ nonce: nextNonce });
      await f.execute({ ...renew, nonce: nextNonce });
      await f.execute({ ...release, nonce: nextNonce });
      expect(mocks.helper).toHaveBeenCalledOnce();
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      await f.owner.close();
    }
    expect(f.children[0]?.exitCode).toBe(0);
    expect(f.owner.hasActiveWork()).toBe(false);
  });

  it("does not admit an already-aborted operation", async () => {
    const f = fixture();
    const caller = new AbortController();
    caller.abort(new Error("caller revoked"));
    await expect(f.execute(acquire, caller.signal)).rejects.toThrow("caller revoked");
    expect(mocks.helper).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    await f.owner.close();
  });

  it("joins exact-nonce standalone recovery cleanup before releasing dead-helper custody", async () => {
    const f = fixture();
    const cleanupEntered = createDeferred();
    const cleaned = createDeferred();
    await f.execute(acquire);
    expect(mocks.helper).toHaveBeenCalledOnce();
    await f.kill();
    await expect(f.execute(renew)).rejects.toThrow("watchdog identity changed");
    expect(f.readLease()).toMatchObject({ nonce });
    mocks.cleanup.mockImplementation(async () => {
      cleanupEntered.resolve();
      await cleaned.promise;
    });
    const releasing = f.execute(release);
    await cleanupEntered.promise;
    const closing = f.owner.close();
    try {
      expect(f.readLease()).toBeUndefined();
      expect(f.releaseWorkspace).not.toHaveBeenCalled();
      expect(f.owner.hasActiveWork()).toBe(true);
    } finally {
      cleaned.resolve();
      await Promise.all([releasing, closing]);
    }
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(f.releaseWorkspace).toHaveBeenCalledTimes(2);
    expect(f.owner.hasActiveWork()).toBe(false);
  });

  it("retains custody when dead-helper recovery cannot certify command cleanup", async () => {
    const f = fixture();
    await f.execute(acquire);
    expect(mocks.helper).toHaveBeenCalledOnce();
    await f.kill();
    const failure = new Error("uncertain Job cleanup");
    mocks.cleanup.mockRejectedValue(failure);
    await expect(f.execute(release)).rejects.toBe(failure);
    expect(mocks.acquire).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      processTree: "required-all",
    });
    expect(f.readLease()).toBeUndefined();
    expect(f.releaseWorkspace).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.owner.close()).rejects.toThrow("workspace quiescence recovery failed");
      expect(f.owner.hasActiveWork()).toBe(true);
      expect(f.releaseWorkspace).not.toHaveBeenCalled();
    }
  });
});
