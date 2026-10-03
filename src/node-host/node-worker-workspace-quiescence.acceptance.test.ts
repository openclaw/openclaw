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
  const readLease = (currentNonce = nonce) =>
    JSON.parse(fs.readFileSync(leasePath.replace(nonce, currentNonce), "utf8")) as {
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
    const controlSpawns = spawned.mock.calls.length;
    await f.command(renew);
    expect(f.readLease().watchdog).toEqual(lease.watchdog);
    expect(processIdentity.requireNodeWorkerProcessIdentity(lease.watchdog.pid)).toEqual(exact);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(true);
    await f.command(release);
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    const nextNonce = "b".repeat(32);
    await f.command({ ...acquire, nonce: nextNonce });
    expect(f.readLease(nextNonce).watchdog).toEqual(lease.watchdog);
    for (const operation of [renew, release]) {
      await expect(f.command(operation)).rejects.toThrow("no longer active");
    }
    await f.command({ ...renew, nonce: nextNonce });
    await f.command({ ...release, nonce: nextNonce });
    const cancelledNonce = "c".repeat(32);
    const late = new AbortController();
    const reused = vi
      .spyOn(f.runtime.quiescence, "execute")
      .mockImplementationOnce((context, signal) => {
        const pending = execute(context, signal);
        late.abort();
        return pending;
      });
    await expect(
      f.command({ ...acquire, nonce: cancelledNonce }, late.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    reused.mockRestore();
    await f.command({ ...release, nonce: cancelledNonce });
    await f.command({ ...acquire, nonce: nextNonce });
    await f.command({ ...release, nonce: nextNonce });
    expect(spawned).toHaveBeenCalledTimes(controlSpawns);
    expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).toBe("live");
    await f.runtime.quiescence.close();
    expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).not.toBe("live");
    await f.collect(2);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it("retires the idle helper before a different workspace generation acquires custody", async () => {
    const f = fixture();
    await f.command(acquire);
    const first = processIdentity.requireNodeWorkerProcessIdentity(f.readLease().watchdog.pid);
    await f.command(release);
    const nextWorkspace = path.join(path.dirname(f.workspaceDir), "2");
    fs.mkdirSync(nextWorkspace);
    await f.runtime.exec({
      ...f.input(acquire),
      generation: 2,
      argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, nextWorkspace],
    });
    expect(processIdentity.inspectNodeWorkerProcessIdentity(first)).not.toBe("live");
    expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
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

  it.each([false, true])(
    "joins an accepted renewal before releasing custody (caller cancelled: %s)",
    async (cancelled) => {
      const f = fixture();
      const preload = path.join(path.dirname(f.workspaceDir), "hold-renewal.cjs");
      fs.writeFileSync(
        preload,
        `const send = process.send.bind(process);
let reply;
process.send = (message, ...args) => {
  if (message?.type === "workspace-quiescence-result" && message.action === "renew") {
    reply = () => send(message, ...args);
    return send({ type: "acceptance-renewal-held" });
  }
  return send(message, ...args);
};
process.on("message", (message) => {
  if (message?.type === "acceptance-renewal-release") { const publish = reply; reply = undefined; publish?.(); }
});`,
      );
      const original = childProcess.spawn;
      const entered = createDeferred<childProcess.ChildProcess>();
      spyOnSpawn().mockImplementationOnce((...args: Parameters<typeof childProcess.spawn>) => {
        const [command, argv, options] = args;
        const child = original(command, ["--require", preload, ...argv], options);
        child.on("message", (message: unknown) => {
          if (isRecord(message) && message.type === "acceptance-renewal-held") {
            entered.resolve(child);
          }
        });
        return child;
      });
      await f.command(acquire);
      const caller = new AbortController();
      const renewal = f.command(renew, caller.signal);
      const helper = await entered.promise;
      if (cancelled) {
        caller.abort();
      }
      const observedRenewal = expect(renewal).rejects.toThrow(
        cancelled ? /aborted/i : /closed|identity changed/,
      );
      const closing = f.runtime.quiescence.close();
      try {
        expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
        expect(fs.existsSync(f.leasePath)).toBe(true);
      } finally {
        helper.send({ type: "acceptance-renewal-release" });
        await Promise.all([observedRenewal, closing]);
      }
      expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
      expect(fs.existsSync(f.leasePath)).toBe(false);
      await f.collect(1);
      expect(fs.existsSync(f.workspaceDir)).toBe(false);
    },
  );

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
    "settles expired controls before helper reuse and shutdown (renewal race: %s)",
    async (renewalRaces) => {
      const f = fixture();
      const preload = path.join(path.dirname(f.workspaceDir), "expiry-clock.cjs");
      fs.writeFileSync(
        preload,
        `const now = Date.now;
let elapsed = 0;
let deadline;
const send = process.send.bind(process);
const emit = process.emit.bind(process);
let holdRetirement = false;
let retirement;
let holdRelease = false;
let releaseControl;
process.emit = (event, message, ...args) => {
  if (holdRelease && event === "message" && message?.type === "workspace-quiescence-control" && message.action === "release") {
    releaseControl = () => emit(event, message, ...args);
    send({ type: "acceptance-release-held" });
    return true;
  }
  if (holdRetirement && event === "message" && message?.type === "workspace-quiescence-retire") {
    retirement = () => emit(event, message, ...args);
    send({ type: "acceptance-retirement-held" });
    return true;
  }
  return emit(event, message, ...args);
};
const replies = [];
process.send = (message, ...args) => {
  if (message?.type === "workspace-quiescence-result" && message.action === "renew") {
    replies.push(() => send(message, ...args));
    return send({ type: "acceptance-renewal-held" });
  }
  return send(message, ...args);
};
Date.now = () => now() + elapsed;
global.setTimeout = (callback) => { deadline = callback; return { unref() {} }; };
process.on("message", (message) => {
  if (message?.type === "acceptance-expire") { elapsed += 60_000; deadline(); }
  if (message?.type === "acceptance-renewal-release") replies.shift()?.();
  if (message?.type === "acceptance-release-hold") holdRelease = true;
  if (message?.type === "acceptance-release-continue") { holdRelease = false; releaseControl?.(); }
  if (message?.type === "acceptance-retirement-hold") holdRetirement = true;
  if (message?.type === "acceptance-retirement-release") { holdRetirement = false; retirement?.(); }
  if (message?.type === "acceptance-control-fence") send({ type: "acceptance-control-fenced" });
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
      if (!renewalRaces) {
        const held = once(helper, "message");
        helper.send({ type: "acceptance-release-hold" });
        const releasing = f.command(release);
        expect((await held)[0]).toEqual({ type: "acceptance-release-held" });
        const stopped = once(helper, "close");
        const outcomes = Promise.allSettled([releasing, f.runtime.quiescence.close()]);
        try {
          const retired = once(helper, "message");
          helper.send({ type: "acceptance-expire" });
          expect((await retired)[0]).toEqual({ type: "workspace-quiescence-retired", nonce });
          expect(await outcomes).toEqual([
            { status: "fulfilled", value: expect.objectContaining({ code: 0 }) },
            { status: "fulfilled", value: undefined },
          ]);
        } finally {
          if (helper.connected) {
            helper.send({ type: "acceptance-release-continue" });
          }
          await stopped;
        }
        expect(helper.exitCode).toBe(0);
      } else {
        const fence = async () => {
          const fenced = once(helper, "message");
          helper.send({ type: "acceptance-control-fence" });
          expect((await fenced)[0]).toEqual({ type: "acceptance-control-fenced" });
        };
        const held = once(helper, "message");
        const renewal = expect(f.command(renew)).rejects.toThrow("lease expired during control");
        expect((await held)[0]).toEqual({ type: "acceptance-renewal-held" });
        const retired = once(helper, "message");
        helper.send({ type: "acceptance-expire" });
        expect((await retired)[0]).toEqual({ type: "workspace-quiescence-retired", nonce });
        await renewal;
        await f.command(release);
        await f.command(acquire);
        expect(f.readLease().watchdog).toEqual(lease.watchdog);
        const currentHeld = once(helper, "message");
        let settled = false;
        const currentRenewal = f.command(renew).then(() => {
          settled = true;
        });
        expect((await currentHeld)[0]).toEqual({ type: "acceptance-renewal-held" });
        try {
          const stale = once(helper, "message");
          helper.send({ type: "acceptance-renewal-release" });
          expect((await stale)[0]).toMatchObject({
            type: "workspace-quiescence-result",
            nonce,
            action: "renew",
          });
          await fence();
          expect(settled).toBe(false);
        } finally {
          helper.send({ type: "acceptance-renewal-release" });
          await currentRenewal;
        }
        const idleExpiry = once(helper, "message");
        helper.send({ type: "acceptance-expire" });
        expect((await idleExpiry)[0]).toEqual({ type: "workspace-quiescence-retired", nonce });
        await f.command(acquire);
        expect(f.readLease().watchdog).toEqual(lease.watchdog);
        const heldAgain = once(helper, "message");
        const expiring = expect(f.command(renew)).rejects.toThrow("lease expired during control");
        expect((await heldAgain)[0]).toEqual({ type: "acceptance-renewal-held" });
        const retirementHeld = createDeferred();
        helper.on("message", (message: unknown) => {
          if (isRecord(message) && message.type === "acceptance-retirement-held") {
            retirementHeld.resolve();
          }
        });
        let closed = false;
        const stopped = once(helper, "close");
        const closing = f.runtime.quiescence.close().then(() => {
          closed = true;
        });
        try {
          helper.send({ type: "acceptance-retirement-hold" });
          helper.send({ type: "acceptance-expire" });
          await expiring;
          await retirementHeld.promise;
          await fence();
          expect(closed).toBe(false);
          expect(helper.exitCode).toBeNull();
          expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
        } finally {
          helper.send({ type: "acceptance-renewal-release" });
          helper.send({ type: "acceptance-retirement-release" });
          await Promise.all([closing, stopped]);
        }
        expect(closed).toBe(true);
      }
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
let holding = true;
process.send = (message, ...args) => {
  if (holding && message?.type === "workspace-quiescence-result" && message.action === "acquire") {
    holding = false;
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
    let restoreLease: (() => void) | undefined;
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
        const raw = fs.readFileSync(f.leasePath, "utf8");
        restoreLease = () => fs.writeFileSync(f.leasePath, raw);
        const lease = f.readLease();
        lease.watchdog.start = "replaced watchdog";
        fs.writeFileSync(f.leasePath, JSON.stringify(lease));
        const readyPublished = once(helper!, "message");
        helper!.send({ type: "acceptance-ready-release" });
        await readyPublished;
        closing = expect(f.runtime.quiescence.close()).rejects.toMatchObject({
          errors: [
            expect.objectContaining({
              message: "native quiescence lease changed its process scope",
            }),
          ],
        });
        await closing;
        expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
        expect(fs.existsSync(f.leasePath)).toBe(true);
        expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).toBe("live");
        return;
      }
      if (mode === "retry") {
        expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
        await f.collect(1);
        expect(fs.existsSync(f.workspaceDir)).toBe(true);
        const nextNonce = "b".repeat(32);
        const recovering = vi.spyOn(getProcessSupervisor(), "spawn");
        const readyPublished = once(helper!, "message");
        helper!.send({ type: "acceptance-ready-release" });
        await readyPublished;
        await expect(f.command({ ...acquire, nonce: nextNonce })).resolves.toMatchObject({
          stdout: "quiesced " + nextNonce + "\n",
        });
        expect(recovering).not.toHaveBeenCalled();
        expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).toBe("live");
        expect(f.readLease(nextNonce).watchdog.pid).toBe(exact.pid);
        expect(fs.existsSync(f.leasePath)).toBe(false);
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
      restoreLease?.();
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
