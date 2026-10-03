import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { workspaceQuiescenceArgv } from "../gateway/worker-environments/workspace-quiescence-scripts.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  NodeWorkerWorkspaceExecInput,
  NodeWorkerWorkspaceQuiescenceInput,
} from "../worker/node-workspace-protocol.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

const DEFAULT_CONTROL_TIMEOUT_MS = 120_000;

type LeaseContext = {
  input: NodeWorkerWorkspaceExecInput;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  retainWorkspace: () => () => void;
};
type Lease = {
  key: string;
  nonce: string;
  context: LeaseContext;
  child: ChildProcess;
  identity?: NodeWorkerProcessIdentity;
  ready: Promise<void>;
  done: Promise<void>;
  started: Promise<void>;
  operations: Promise<unknown>;
  acquisitionWaiters: number;
  acknowledged: boolean;
  exited: boolean;
  released: boolean;
  releaseWorkspace: () => void;
  releasing?: Promise<void>;
  control?: { action: "renew" | "release"; receipt: ReturnType<typeof createDeferredCore<string>> };
};

/** Infrastructure leases outlive commands and environment-owned preview processes. */
export class NodeWorkerWorkspaceQuiescence {
  private readonly leases = new Map<string, Lease>();
  private readonly controls = new Map<Promise<void>, number>();
  private readonly supervisor = getProcessSupervisor();
  private closed = false;

  hasActiveWork(): boolean {
    return this.leases.size > 0 || this.controls.size > 0;
  }

  async execute(context: LeaseContext, signal?: AbortSignal): Promise<string> {
    const observe = <T>(operation: Promise<T>) =>
      withTimeout(
        racePromiseWithAbortSignal(operation, signal),
        context.input.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
        { message: "workspace quiescence control timed out; custody remains retained" },
      );
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (this.closed) {
        throw new Error("workspace quiescence owner is closed");
      }
    };
    assertCurrent();
    const operation = context.input.quiescence!;
    // Windows already uses a shared-host SQLite lease without freezing or a detached child.
    if (process.platform === "win32") {
      return this.runScript(context, operation, signal);
    }
    const key = JSON.stringify([
      context.input.gatewayNamespace,
      context.input.environmentId,
      context.input.sessionId,
      context.input.generation,
      context.workspaceDir,
      context.env.HOME,
    ]);
    let lease = this.leases.get(key);
    if (operation.action === "acquire") {
      if (
        lease &&
        lease.nonce !== operation.nonce &&
        (lease.exited || (!lease.acknowledged && lease.acquisitionWaiters === 0))
      ) {
        // Recover a failed or abandoned acquisition, never another caller's live lease.
        // Cancellation bounds this observer, not the retained exact-nonce recovery.
        await observe(this.release(lease));
        lease = this.leases.get(key);
      }
      if (lease && lease.nonce !== operation.nonce) {
        throw new Error("workspace quiescence lease is already active");
      }
      assertCurrent();
      lease ??= this.acquire(key, context, operation);
      lease.acquisitionWaiters++;
      try {
        await observe(lease.ready);
        assertCurrent();
        this.assertActive(lease);
        lease.acknowledged = true;
        return "quiesced " + lease.nonce + "\n";
      } finally {
        lease.acquisitionWaiters--;
        if (!lease.acknowledged && lease.acquisitionWaiters === 0) {
          // The caller has no handle to release. Keep custody through startup and
          // observe recovery failure; a later release/close/acquire can retry it.
          void this.release(lease).catch(() => undefined);
        }
      }
    }
    if (!lease || lease.nonce !== operation.nonce) {
      // Release is idempotent after expiry, but cannot borrow another lease's watchdog.
      if (!lease && operation.action === "release") {
        return "";
      }
      throw new Error("workspace quiescence lease is no longer active");
    }
    if (operation.action === "release") {
      await observe(this.release(lease));
      return "";
    }
    const owned = lease;
    const renewal = owned.operations.then(async () => {
      assertCurrent();
      const result = await this.control(owned, operation);
      assertCurrent();
      this.assertActive(owned);
      return result;
    });
    owned.operations = renewal.catch(() => undefined);
    // Cancellation bounds the observer; an accepted control remains in the lease's
    // queue until its acknowledgement or child exit lets release settle it.
    return observe(renewal);
  }

  async close(): Promise<void> {
    this.closed = true;
    const leases = [...this.leases.values()];
    if (leases.length === 0 && this.controls.size === 0) {
      return;
    }
    const recoveryTimeoutMs = Math.max(
      1,
      ...this.controls.values(),
      ...leases.map((lease) => lease.context.input.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS),
    );
    // Bound shutdown observation, not the last resumer. Timed-out recovery keeps
    // its lease/control and workspace holds until actual cleanup settles.
    const outcomes = await withTimeout(
      Promise.allSettled([...this.controls.keys(), ...leases.map((lease) => this.release(lease))]),
      recoveryTimeoutMs,
      { message: "workspace quiescence recovery timed out; custody remains retained" },
    );
    const failures = outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "workspace quiescence recovery failed");
    }
  }

  private assertActive(lease: Lease, releasing = false): void {
    if (
      (!releasing && (this.closed || lease.releasing)) ||
      this.leases.get(lease.key) !== lease ||
      lease.exited ||
      !lease.identity ||
      inspectNodeWorkerProcessIdentity(lease.identity) !== "live"
    ) {
      throw new Error("workspace quiescence watchdog identity changed unexpectedly");
    }
  }

  private retire(lease: Lease): void {
    if (!lease.exited || !lease.released || this.leases.get(lease.key) !== lease) {
      return;
    }
    this.leases.delete(lease.key);
    lease.releaseWorkspace();
  }

  private acquire(
    key: string,
    context: LeaseContext,
    operation: Extract<NodeWorkerWorkspaceQuiescenceInput, { action: "acquire" }>,
  ): Lease {
    const ready = createDeferredCore();
    const done = createDeferredCore();
    const started = createDeferredCore();
    const releaseWorkspace = context.retainWorkspace();
    let child: ChildProcess;
    try {
      // Fixed recovery-only code, owned directly by this persistent native runtime.
      // Never spawn it below a command anchor or install the harness PID as its watchdog.
      child = spawn(
        process.execPath,
        workspaceQuiescenceArgv(context.workspaceDir, operation, "shared-host", "owned").slice(1),
        { cwd: context.workspaceDir, env: context.env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
    } catch (error) {
      releaseWorkspace();
      throw error;
    }
    const lease: Lease = {
      key,
      context,
      nonce: operation.nonce,
      child,
      ready: ready.promise,
      done: done.promise,
      started: started.promise,
      operations: Promise.resolve(),
      acquisitionWaiters: 0,
      acknowledged: false,
      exited: false,
      released: false,
      releaseWorkspace,
    };
    this.leases.set(key, lease);
    void lease.ready.catch(() => undefined);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    child.stdout?.resume();
    child.once("spawn", () => {
      try {
        lease.identity = requireNodeWorkerProcessIdentity(child.pid!);
      } catch (error) {
        ready.reject(error);
      }
    });
    child.on("message", (message: unknown) => {
      if (!isRecord(message) || message.nonce !== lease.nonce) {
        return;
      }
      if (message.type === "workspace-quiescence-ready") {
        started.resolve();
        try {
          this.assertActive(lease);
          ready.resolve();
        } catch (error) {
          ready.reject(error);
        }
      } else if (message.type === "workspace-quiescence-retired") {
        lease.released = true;
      } else if (
        message.type === "workspace-quiescence-result" &&
        lease.control &&
        lease.control.action === message.action
      ) {
        const { action, receipt } = lease.control;
        if (typeof message.error === "string") {
          receipt.reject(new Error(message.error));
        } else {
          receipt.resolve(action === "renew" ? "renewed " + lease.nonce + "\n" : "");
        }
      }
    });
    child.once("error", (error) => ready.reject(error));
    child.once("close", (code) => {
      lease.exited = true;
      started.resolve();
      // Spawn refusal has no lease; failed expiry still requires explicit recovery.
      lease.released = !child.pid || (code === 0 && lease.released);
      ready.reject(new Error(stderr || "workspace quiescence watchdog exited before readiness"));
      lease.control?.receipt.reject(
        new Error("workspace quiescence watchdog exited during control"),
      );
      this.retire(lease);
      done.resolve();
    });
    return lease;
  }

  private release(lease: Lease): Promise<void> {
    lease.releasing ??= (async () => {
      await lease.operations;
      await lease.started;
      if (lease.released) {
        await lease.done;
      }
      if (this.leases.get(lease.key) !== lease) {
        // Spawn refusal or completed expiry already retired this exact owner.
        return;
      }
      const operation = { action: "release", nonce: lease.nonce } as const;
      try {
        await this.control(lease, operation);
      } catch (error) {
        if (!lease.exited) {
          throw error;
        }
        // A dead helper cannot acknowledge recovery; the standalone owner validates
        // and removes its empty lease without signalling any recorded PID.
        await this.runScript(lease.context, operation);
      }
      await lease.done;
      lease.released = true;
      this.retire(lease);
    })().catch((error: unknown) => {
      lease.releasing = undefined;
      throw error;
    });
    return lease.releasing;
  }

  private async control(
    lease: Lease,
    operation: Exclude<NodeWorkerWorkspaceQuiescenceInput, { action: "acquire" }>,
  ): Promise<string> {
    this.assertActive(lease, operation.action === "release");
    const receipt = createDeferredCore<string>();
    lease.control = { action: operation.action, receipt };
    try {
      lease.child.send({ type: "workspace-quiescence-control", ...operation }, (error) => {
        if (error) {
          receipt.reject(error);
        }
      });
      return await receipt.promise;
    } finally {
      lease.control = undefined;
    }
  }

  private async runScript(
    context: LeaseContext,
    operation: NodeWorkerWorkspaceQuiescenceInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const runId = randomUUID();
    const scopeKey = "workspace-quiescence-control:" + runId;
    const cleanup = this.supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
    const completed = createDeferredCore();
    this.controls.set(completed.promise, context.input.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS);
    // A failed cleanup remains owned, even after its caller observes the error.
    void completed.promise.catch(() => undefined);
    let releaseWorkspace: (() => void) | undefined;
    const finishControl = async () => {
      try {
        await cleanup();
        releaseWorkspace?.();
        this.controls.delete(completed.promise);
        completed.resolve();
      } catch (error) {
        // The scope owner caches uncertain extinction; close must not turn it
        // into success or release workspace custody on a later attempt.
        completed.reject(error);
        throw error;
      }
    };
    const abort = () => this.supervisor.cancel(runId);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      releaseWorkspace = context.retainWorkspace();
      const run = await this.supervisor.spawn({
        mode: "child",
        runId,
        scopeKey,
        argv: [
          process.execPath,
          ...workspaceQuiescenceArgv(context.workspaceDir, operation, "shared-host", "owned").slice(
            1,
          ),
        ],
        cwd: context.workspaceDir,
        env: context.env,
        exactEnv: true,
        stdinMode: "pipe-closed",
        timeoutMs: context.input.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
        maxCapturedOutputChars: 16_384,
        assertCurrent: () => signal?.throwIfAborted(),
      });
      if (signal?.aborted) {
        abort();
      }
      const result = await run.wait();
      if (result.exitCode !== 0 || result.exitSignal !== null) {
        throw new Error(result.stderr || "workspace quiescence operation failed");
      }
      return result.stdout;
    } finally {
      signal?.removeEventListener("abort", abort);
      await finishControl();
    }
  }
}
