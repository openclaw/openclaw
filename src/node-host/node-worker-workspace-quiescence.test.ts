import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { workspaceQuiescenceArgv } from "../gateway/worker-environments/workspace-quiescence-scripts.js";
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

function fixture(guestPlatform: "win32" | "linux" = "win32") {
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
    const storage = path.join(home, ".openclaw-worker", "quiescence");
    const key = createHash("sha256").update(workspaceDir).digest("hex");
    if (guestPlatform === "linux") {
      const lease = path.join(storage, key + "." + nonce + ".json");
      return fs.existsSync(lease) ? JSON.parse(fs.readFileSync(lease, "utf8")) : undefined;
    }
    using database = new DatabaseSync(path.join(storage, "windows-shared-host.sqlite"), {
      readOnly: true,
    });
    const row = database
      .prepare("SELECT lease_json FROM workspace_leases WHERE workspace_key = ?")
      .get(key);
    return row ? JSON.parse(String(row.lease_json)) : undefined;
  };

  // Execute the generated program with real lease storage and IPC receipts.
  // Only the OS transport, process identity and expiry clock are simulated.
  const script = (args: readonly string[], child?: ChildProcess) => {
    const inline = args[0] === "-e";
    const fileOffset = args[0] === "--no-install" ? 1 : 0;
    const filename = args[fileOffset];
    if (!filename) {
      throw new Error("expected quiescence entry");
    }
    const source = inline
      ? args[1]
      : transformSync(fs.readFileSync(filename, "utf8"), {
          format: "cjs",
          sourcefile: filename,
          define: { "import.meta.url": JSON.stringify(pathToFileURL(filename).href) },
          logLevel: "silent",
        }).code;
    if (source === undefined) {
      throw new Error("expected quiescence program");
    }
    const result = { stdout: "", stderr: "", exitCode: 0 };
    const stdin = new PassThrough();
    const exited = new Error("script exited");
    const pid = child?.pid ?? 9000;
    const writeStderr = (text: string) => {
      result.stderr += text;
      child?.stderr?.emit("data", Buffer.from(text));
    };
    const finish = (code: number) => {
      result.exitCode = code;
      if (child && mocks.live.delete(pid)) {
        Object.defineProperties(child, {
          connected: { configurable: true, value: false },
          exitCode: { configurable: true, value: code },
        });
        queueMicrotask(() => child.emit("close", code, null));
      }
    };
    const guest = Object.assign(new EventEmitter(), {
      argv: [process.execPath, ...args.slice(inline ? 2 : fileOffset)],
      platform: guestPlatform,
      getuid: () => 0,
      kill: () => {
        throw new Error("native quiescence must not signal any process");
      },
      pid,
      execPath: process.execPath,
      stdin,
      stdout: { write: (text: string) => (result.stdout += text) },
      stderr: { write: writeStderr },
      disconnect: () => {
        expect(stdin.destroyed).toBe(true);
        finish(result.exitCode);
      },
      send: (message: unknown) => queueMicrotask(() => child?.emit("message", message)),
      exit: (code: number) => {
        finish(code);
        throw exited;
      },
    });
    Object.defineProperty(guest, "exitCode", {
      get: () => result.exitCode,
      set: (code: number) => {
        result.exitCode = code;
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
    const requireRemote = (name: string): unknown => {
      if (name === "node:module") {
        return { createRequire: () => requireRemote };
      }
      if (name === "node:os") {
        return { homedir: () => home };
      }
      if (name === "node:child_process") {
        return {
          execFileSync: (command: string, probeArgs: string[]) => {
            if (command !== "ps" || probeArgs[0] !== "-o" || probeArgs.at(-1) !== String(pid)) {
              throw new Error("native quiescence must only inspect its watchdog");
            }
            return "Tue Oct  6 19:00:00 2026\n";
          },
        };
      }
      return require(name);
    };
    const guestModule = { exports: {} };
    try {
      runInNewContext(source, {
        module: guestModule,
        exports: guestModule.exports,
        process: guest,
        require: requireRemote,
        setTimeout: () => 1,
        clearTimeout: () => {},
        performance,
      });
    } catch (error) {
      if (error !== exited) {
        writeStderr(String(error));
        finish(1);
      }
    }
    return result;
  };
  mocks.helper.mockImplementation((_command, args) => {
    if (!Array.isArray(args) || args[0] === "-e") {
      throw new Error("local helper requires a packaged entry file");
    }
    const child = new ChildProcess();
    const pid = 1000 + children.length;
    Object.defineProperties(child, {
      pid: { value: pid },
      connected: { configurable: true, value: true },
      stderr: { value: new PassThrough() },
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
    if (input.argv[1] === "-e") {
      throw new Error("local recovery requires a packaged entry file");
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
    script,
    workspaceDir,
    kill: async () => {
      const child = children.at(-1)!;
      const closed = once(child, "close");
      exits.get(child)!();
      await closed;
    },
  };
}

describe("root-owned POSIX quiescence", () => {
  it("acquires, renews and releases native custody without scanning or signaling root processes", async () => {
    const f = fixture("linux");
    try {
      await expect(f.execute(acquire)).resolves.toBe("quiesced " + nonce + "\n");
      expect(f.readLease()).toMatchObject({
        nonce,
        sharedHost: true,
        processes: [],
        watchdog: { pid: f.children[0]?.pid },
      });
      await expect(f.execute(renew)).resolves.toBe("renewed " + nonce + "\n");
      await f.execute(release);
      expect(f.readLease()).toBeUndefined();
    } finally {
      await f.owner.close();
    }
    expect(f.children[0]?.exitCode).toBe(0);
  });

  it.each(["dedicated", "shared-host"] as const)(
    "keeps detached %s acquisition unavailable to root",
    async (hostMode) => {
      const f = fixture("linux");
      const result = f.script(workspaceQuiescenceArgv(f.workspaceDir, acquire, hostMode).slice(1));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("workspace quiescence refuses root-owned worker sessions");
      expect(f.readLease()).toBeUndefined();
      await f.owner.close();
    },
  );
});

describe("Windows-selected quiescence controller contracts", () => {
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
    const cleanupGate = createEnteredGate();
    await f.execute(acquire);
    expect(mocks.helper).toHaveBeenCalledOnce();
    await f.kill();
    await expect(f.execute(renew)).rejects.toThrow("watchdog identity changed");
    expect(f.readLease()).toMatchObject({ nonce });
    mocks.cleanup.mockImplementation(cleanupGate.wait);
    const releasing = f.execute(release);
    await cleanupGate.entered;
    const closing = f.owner.close();
    try {
      expect(f.readLease()).toBeUndefined();
      expect(f.releaseWorkspace).not.toHaveBeenCalled();
      expect(f.owner.hasActiveWork()).toBe(true);
    } finally {
      cleanupGate.release();
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
