import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { REMOTE_WORKSPACE_RESUME_JS } from "../gateway/worker-environments/workspace-quiescence-scripts.js";
import { createWorkerWorkspaceQuiescence } from "../gateway/worker-environments/workspace-quiescence.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  NODE_WORKSPACE_QUIESCENCE_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceQuiescenceInput,
} from "../worker/node-workspace-protocol.js";
import * as processIdentity from "./node-worker-process-identity.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspaces: NodeWorkerWorkspaceRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const runtime of workspaces.splice(0)) {
    await runtime.quiescence.close();
    await runtime.processes.close();
  }
});
function spyOnSpawn() {
  const spy = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  return spy;
}
const identity = {
  gatewayNamespace: "gateway-watchdog",
  environmentId: "worker-watchdog",
  sessionId: "session-watchdog",
  generation: 1,
};
const nonce = "a".repeat(32);
function fixture() {
  const root = fs.realpathSync(tempDirs.make("node-watchdog-acceptance-"));
  const hash = (text: string, size: number) =>
    createHash("sha256").update(text).digest("hex").slice(0, size);
  const home = path.join(
    root,
    identity.gatewayNamespace,
    "workspaces",
    hash(identity.environmentId, 16),
    hash(identity.sessionId, 32),
  );
  const workspaceDir = path.join(home, "1");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const runtime = new NodeWorkerWorkspaceRuntime({
    root,
    env: { PATH: process.env.PATH, HOME: root },
  });
  workspaces.push(runtime);
  const input = (operation: NodeWorkerWorkspaceQuiescenceInput) => ({
    ...identity,
    argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, workspaceDir],
    quiescence: operation,
  });
  const command = (operation: NodeWorkerWorkspaceQuiescenceInput, signal?: AbortSignal) =>
    runtime.exec(parseNodeWorkerWorkspaceExecInput(JSON.stringify(input(operation))), signal);
  const leasePath = path.join(
    home,
    ".openclaw-worker",
    "quiescence",
    hash(workspaceDir, 64) + "." + nonce + ".json",
  );
  const readLease = () =>
    JSON.parse(fs.readFileSync(leasePath, "utf8")) as {
      nonce: string;
      sharedHost: boolean;
      processes: unknown[];
      watchdog: { pid: number; start: string };
      expiresAtMs: number;
    };
  const collect = (sequence: number) =>
    runtime.applyRetainSnapshot(
      {
        version: 1,
        gatewayNamespace: identity.gatewayNamespace,
        controllerId: "watchdog-proof",
        sequence,
        retain: [],
      },
      async () => [],
    );
  return { runtime, input, command, workspaceDir, leasePath, readLease, collect };
}
const acquire = { action: "acquire", nonce, timeoutMs: 30_000 } as const;
const renew = { action: "renew", nonce, timeoutMs: 30_000, validationMode: "final" } as const;
const release = { action: "release", nonce } as const;

describe.runIf(process.platform === "linux")("native watchdog lifecycle", () => {
  it("keeps the exact helper identity through foreground cleanup and environment-app shutdown, and retains custody until release", async () => {
    const f = fixture();
    const original = childProcess.spawn;
    let refused: Promise<unknown> | undefined;
    const spawned = spyOnSpawn().mockImplementationOnce(
      (...args: Parameters<typeof childProcess.spawn>) => {
        const [command, argv, options] = args;
        const child = original(command, argv, {
          ...options,
          cwd: path.join(f.workspaceDir, "missing"),
        });
        refused = new Promise((resolve) => {
          child.once("close", resolve);
        });
        return child;
      },
    );
    await expect(f.command(acquire)).rejects.toThrow("ENOENT");
    await refused;
    await f.command(acquire);
    const lease = f.readLease();
    const duplicate = new AbortController();
    const execute = f.runtime.quiescence.execute.bind(f.runtime.quiescence);
    const executing = vi
      .spyOn(f.runtime.quiescence, "execute")
      .mockImplementationOnce((context, signal) => {
        const pending = execute(context, signal);
        duplicate.abort();
        return pending;
      });
    await expect(f.command(acquire, duplicate.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    executing.mockRestore();
    const exact = processIdentity.requireNodeWorkerProcessIdentity(lease.watchdog.pid);
    expect(lease).toMatchObject({ nonce, sharedHost: true, processes: [] });
    expect(lease.watchdog.pid).not.toBe(process.pid);
    const helper = spawned.mock.results.flatMap((result) =>
      result.type === "return" && result.value.pid === lease.watchdog.pid ? [result.value] : [],
    )[0]!;
    expect(helper).toBeDefined();
    expect(fs.readFileSync("/proc/" + helper.pid + "/status", "utf8")).toContain(
      "PPid:\t" + process.pid,
    );
    await f.runtime.exec({
      ...identity,
      argv: [path.basename(process.execPath), "-e", "process.stdout.write('command-cleanup')"],
      nativeProcessOwner: true,
    });
    expect(processIdentity.requireNodeWorkerProcessIdentity(lease.watchdog.pid)).toEqual(exact);
    await f.runtime.exec({
      ...identity,
      argv: [
        path.basename(process.execPath),
        "-e",
        'require("node:net").createServer().listen(0, "127.0.0.1")',
      ],
      process: { action: "start", processId: "owned-app" },
    });
    await f.runtime.processes.stopEnvironment({
      gatewayNamespace: identity.gatewayNamespace,
      environmentId: identity.environmentId,
      ownerEpoch: 1,
    });
    expect(f.runtime.processes.hasActiveWork()).toBe(false);
    expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
    await f.command(renew);
    expect(f.readLease().watchdog).toEqual(lease.watchdog);
    expect(processIdentity.requireNodeWorkerProcessIdentity(lease.watchdog.pid)).toEqual(exact);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(true);
    const done = once(helper, "close");
    await f.command(release);
    await done;
    expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).not.toBe("live");
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    await f.collect(2);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it("rejects nonce, namespace, root and incompatible input without borrowing or retiring the live helper", async () => {
    const f = fixture();
    await f.command(acquire);
    const lease = f.readLease();
    for (const action of ["acquire", "renew", "release"] as const) {
      const operation = action === "acquire" ? acquire : action === "renew" ? renew : release;
      await expect(f.command({ ...operation, nonce: "b".repeat(32) })).rejects.toThrow(
        /already active|no longer active/,
      );
    }
    await expect(
      f.runtime.exec({ ...f.input(renew), gatewayNamespace: "gateway-other" }),
    ).rejects.toThrow("root does not match its owner");
    await expect(
      f.runtime.exec({
        ...f.input(renew),
        argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, path.dirname(f.workspaceDir)],
      }),
    ).rejects.toThrow("root does not match its owner");
    for (const extra of [
      { input: "caller-script" },
      { resetWorkspace: true },
      { process: { action: "start", processId: "app" } },
    ]) {
      expect(() =>
        parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...f.input(acquire), ...extra })),
      ).toThrow();
    }
    await f.command(renew);
    expect(f.readLease().watchdog).toEqual(lease.watchdog);
  });

  it.each(["reused", "unknown"] as const)(
    "fails closed and retains workspace custody for a %s helper identity",
    async (state) => {
      const f = fixture();
      await f.command(acquire);
      const lease = f.readLease();
      const inspect = processIdentity.inspectNodeWorkerProcessIdentity;
      const mocked = vi
        .spyOn(processIdentity, "inspectNodeWorkerProcessIdentity")
        .mockImplementation((observed) =>
          observed.pid === lease.watchdog.pid ? state : inspect(observed),
        );
      await expect(f.command(renew)).rejects.toThrow("watchdog identity changed");
      expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
      await f.collect(1);
      expect(fs.existsSync(f.workspaceDir)).toBe(true);
      mocked.mockRestore();
      await f.command(renew);
    },
  );

  it("keeps unexpected helper death in custody until authorized recovery", async () => {
    const f = fixture();
    const spawned = spyOnSpawn();
    await f.command(acquire);
    const lease = f.readLease();
    const helper = spawned.mock.results.flatMap((result) =>
      result.type === "return" && result.value.pid === lease.watchdog.pid ? [result.value] : [],
    )[0]!;
    const done = once(helper, "close");
    helper.kill("SIGKILL");
    await done;
    await expect(f.command(renew)).rejects.toThrow("watchdog identity changed");
    expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(true);
    await f.command(release);
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    await f.collect(2);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it("joins an in-flight renewal before closing the native lease and releases its hold", async () => {
    const f = fixture();
    await f.command(acquire);
    const supervisor = getProcessSupervisor();
    const original = supervisor.spawn.bind(supervisor);
    const entered = createDeferred();
    const unblock = createDeferred();
    const spy = vi.spyOn(supervisor, "spawn").mockImplementationOnce(async (input) => {
      entered.resolve();
      await unblock.promise;
      return original(input);
    });
    const renewal = f.command(renew);
    await entered.promise;
    const closing = f.runtime.quiescence.close();
    const observedRenewal = expect(renewal).rejects.toThrow(/closed|identity changed/);
    try {
      expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
      expect(fs.existsSync(f.leasePath)).toBe(true);
    } finally {
      // A failed assertion must not leave teardown waiting on this test-owned gate.
      unblock.resolve();
      await Promise.all([observedRenewal, closing]);
    }
    expect(spy).toHaveBeenCalledTimes(2);
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it("joins startup before close removes the lease and retained child", async () => {
    const f = fixture();
    const original = childProcess.spawn;
    const entered = createDeferred();
    spyOnSpawn().mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args);
      entered.resolve();
      return child;
    });
    const acquiring = f.command(acquire);
    const rejected = expect(acquiring).rejects.toThrow(/closed|identity changed/);
    await entered.promise;
    await f.runtime.quiescence.close();
    await rejected;
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it.each([false, true])(
    "joins expiry IPC and actual child close before surrendering workspace custody (release race: %s)",
    async (releaseRaces) => {
      const f = fixture();
      const preload = path.join(path.dirname(f.workspaceDir), "expiry-clock.cjs");
      fs.writeFileSync(
        preload,
        `const now = Date.now;
let elapsed = 0;
let deadline;
Date.now = () => now() + elapsed;
global.setTimeout = (callback) => { deadline = callback; return { unref() {} }; };
process.on("message", (message) => {
  if (message?.type === "acceptance-expire") { elapsed += 60_000; deadline(); }
});`,
      );
      const original = childProcess.spawn;
      // Only the watchdog owns this clock; release controls must keep their real timers.
      const spawned = spyOnSpawn().mockImplementationOnce(
        (...args: Parameters<typeof childProcess.spawn>) => {
          const [command, argv, options] = args;
          return original(command, ["--require", preload, ...argv], options);
        },
      );
      await f.command(acquire);
      const lease = f.readLease();
      const helper = spawned.mock.results.flatMap((result) =>
        result.type === "return" && result.value.pid === lease.watchdog.pid ? [result.value] : [],
      )[0]!;
      const retired = once(helper, "message");
      const closed = once(helper, "close");
      helper.send({ type: "acceptance-expire" });
      expect((await retired)[0]).toEqual({ type: "workspace-quiescence-retired", nonce });
      expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
      const releasing = releaseRaces ? f.command(release) : Promise.resolve();
      await closed;
      await releasing;
      expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
      expect(fs.existsSync(f.leasePath)).toBe(false);
      await f.collect(1);
      expect(fs.existsSync(f.workspaceDir)).toBe(false);
    },
  );
});

it.runIf(process.platform === "linux")(
  "preserves an older Gateway's detached lease on the new node-host command route",
  async () => {
    const f = fixture();
    const retainedProcess = vi.spyOn(f.runtime.processes, "execute");
    const quiesce = createWorkerWorkspaceQuiescence({
      ownerSignal: new AbortController().signal,
      sharedHost: true,
      runWorkspaceCommand: (command) =>
        f.runtime.exec(
          parseNodeWorkerWorkspaceExecInput(
            JSON.stringify({
              ...identity,
              argv: command.argv,
            }),
          ),
        ),
    });
    const lease = await quiesce(f.workspaceDir);
    try {
      await f.runtime.exec({
        ...identity,
        argv: [path.basename(process.execPath), "-e", "process.stdout.write('legacy-command')"],
      });
      await lease.assertActive();
      expect(retainedProcess).not.toHaveBeenCalled();
      expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    } finally {
      await lease.resume();
    }
  },
);

it.runIf(process.platform === "linux").each(["retry", "close", "recovery-error"] as const)(
  "recovers an abandoned acquisition while retaining startup custody (%s)",
  async (mode) => {
    const f = fixture();
    const preload = path.join(path.dirname(f.workspaceDir), "hold-ready.cjs");
    fs.writeFileSync(
      preload,
      `const send = process.send.bind(process);
let ready;
process.send = (message, ...args) => {
  if (message?.type === "workspace-quiescence-ready") {
    ready = () => send(message, ...args);
    return send({ type: "acceptance-ready-held" });
  }
  return send(message, ...args);
};
process.on("message", (message) => {
  if (message?.type === "acceptance-ready-release") { const publish = ready; ready = undefined; publish?.(); }
});`,
    );
    const held = createDeferred<childProcess.ChildProcess>();
    const original = childProcess.spawn;
    let helper: childProcess.ChildProcess | undefined;
    spyOnSpawn().mockImplementationOnce((...args: Parameters<typeof childProcess.spawn>) => {
      const [command, argv, options] = args;
      helper = original(command, ["--require", preload, ...argv], options);
      const child = helper;
      child.on("message", (message: unknown) => {
        if (isRecord(message) && message.type === "acceptance-ready-held") {
          held.resolve(child);
        }
      });
      child.once("error", held.reject);
      child.once("close", () => held.reject(new Error("helper closed before held readiness")));
      return child;
    });
    const caller = new AbortController();
    const acquiring = f.runtime.exec({ ...f.input(acquire), timeoutMs: 37_000 }, caller.signal);
    const acquisition = acquiring.catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    let unblockRecovery: (() => void) | undefined;
    try {
      await held.promise;
      caller.abort();
      await expect(acquisition).resolves.toMatchObject({ name: "AbortError" });
      const exact = processIdentity.requireNodeWorkerProcessIdentity(f.readLease().watchdog.pid);
      if (mode !== "retry") {
        // Reconciliation and fresh-nonce retry can time out while startup is
        // unknown. Observers return without cancelling the shared resumer.
        for (const operation of [release, { ...acquire, nonce: "b".repeat(32) }]) {
          const observer = new AbortController();
          const execute = f.runtime.quiescence.execute.bind(f.runtime.quiescence);
          const joining = vi
            .spyOn(f.runtime.quiescence, "execute")
            .mockImplementationOnce((context, signal) => {
              const pending = execute(context, signal);
              observer.abort();
              return pending;
            });
          await expect(f.command(operation, observer.signal)).rejects.toMatchObject({
            name: "AbortError",
          });
          joining.mockRestore();
        }
      }
      if (mode === "recovery-error") {
        const failed = createDeferred<never>();
        void failed.promise.catch(() => undefined);
        const failure = new Error("recovery failed");
        unblockRecovery = () => failed.reject(failure);
        const recovering = vi
          .spyOn(getProcessSupervisor(), "spawn")
          .mockImplementationOnce(() => failed.promise);
        const readyPublished = once(helper!, "message");
        helper!.send({ type: "acceptance-ready-release" });
        await readyPublished;
        expect(recovering).toHaveBeenCalledOnce();
        closing = expect(f.runtime.quiescence.close()).rejects.toMatchObject({ errors: [failure] });
        failed.reject(failure);
        await closing;
        expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
        expect(fs.existsSync(f.leasePath)).toBe(true);
        expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).toBe("live");
        // Finally retries the failed exact-lease recovery, not a replacement PID.
        return;
      }
      if (mode === "retry") {
        expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
        await f.collect(1);
        expect(fs.existsSync(f.workspaceDir)).toBe(true);
        const nextNonce = "b".repeat(32);
        const recovering = vi.spyOn(getProcessSupervisor(), "spawn");
        const readyPublished = once(helper!, "message");
        const retired = once(helper!, "close");
        helper!.send({ type: "acceptance-ready-release" });
        await readyPublished;
        // The startup event resumes the owner's cleanup before this observer.
        // No close, release request or retry is allowed to initiate recovery.
        expect(recovering).toHaveBeenCalledOnce();
        expect(recovering).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: "child",
            argv: [
              process.execPath,
              "-e",
              REMOTE_WORKSPACE_RESUME_JS,
              f.workspaceDir,
              nonce,
              "owned",
            ],
          }),
        );
        await retired;
        expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).not.toBe("live");
        expect(fs.existsSync(f.leasePath)).toBe(false);
        await expect(f.command({ ...acquire, nonce: nextNonce })).resolves.toMatchObject({
          stdout: "quiesced " + nextNonce + "\n",
        });
        await f.command({ ...release, nonce: nextNonce });
        await f.collect(2);
        expect(fs.existsSync(f.workspaceDir)).toBe(false);
        return;
      }
      vi.useFakeTimers();
      let outcome = "pending";
      let failure: unknown;
      closing = f.runtime.quiescence.close().then(
        () => {
          outcome = "completed";
        },
        (error: unknown) => {
          outcome = "failed";
          failure = error;
        },
      );
      await vi.advanceTimersByTimeAsync(37_000);
      expect(outcome).toBe("failed");
      expect(failure).toMatchObject({
        message: expect.stringContaining("custody remains retained"),
      });
      expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
      expect(fs.existsSync(f.leasePath)).toBe(true);
      expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).toBe("live");
    } finally {
      vi.useRealTimers();
      unblockRecovery?.();
      caller.abort();
      if (helper?.connected) {
        helper.send({ type: "acceptance-ready-release" });
      }
      await acquisition;
      await closing;
      await f.runtime.quiescence.close();
      expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
      expect(fs.existsSync(f.leasePath)).toBe(false);
    }
  },
);
