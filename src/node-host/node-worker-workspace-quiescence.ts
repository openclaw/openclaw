import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
  done: Promise<void>;
  operations: Promise<unknown>;
  acquisitionWaiters: number;
  acknowledged: boolean;
  exited: boolean;
  released: boolean;
  releaseWorkspace: () => void;
  releasing?: Promise<void>;
  control?: {
    id?: string;
    action: NodeWorkerWorkspaceQuiescenceInput["action"];
    receipt: ReturnType<typeof createDeferredCore<void>>;
  };
};

/** Infrastructure leases outlive commands and environment-owned preview processes. */
export class NodeWorkerWorkspaceQuiescence {
  private readonly leases = new Map<string, Lease>();
  private idle?: Lease;
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
        // Recover abandoned acquisition without cancelling its exact-nonce recovery.
        await observe(this.release(lease));
        lease = this.leases.get(key);
      }
      if (!lease && this.idle && this.idle.key !== key) {
        await observe(this.retireHelper(this.idle));
        lease = this.leases.get(key);
      }
      if (lease && lease.nonce !== operation.nonce) {
        throw new Error("workspace quiescence lease is already active");
      }
      assertCurrent();
      lease ??= this.acquire(key, context, operation);
      lease.acquisitionWaiters++;
      try {
        await observe(lease.operations);
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
      await this.control(owned, operation);
      assertCurrent();
      this.assertActive(owned);
      return "renewed " + owned.nonce + "\n";
    });
    owned.operations = renewal.catch(() => undefined);
    // Cancellation bounds observation; release still joins accepted controls.
    return observe(renewal);
  }

  async close(): Promise<void> {
    this.closed = true;
    const leases = [...this.leases.values()];
    if (this.idle) {
      void this.retireHelper(this.idle);
    }
    const recoveryTimeoutMs = Math.max(
      1,
      ...this.controls.values(),
      ...leases.map((lease) => lease.context.input.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS),
    );
    // Timeout cannot surrender the last resumer's workspace custody.
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
    if (!lease.released || this.leases.get(lease.key) !== lease) {
      return;
    }
    this.leases.delete(lease.key);
    lease.releaseWorkspace();
    if (!lease.exited) {
      if (!this.closed && !this.idle && lease.identity) {
        this.idle = lease;
      } else {
        void this.retireHelper(lease);
      }
    }
  }

  private retireHelper(lease: Lease): Promise<void> {
    if (this.idle === lease) {
      this.idle = undefined;
    }
    this.controls.set(lease.done, lease.context.input.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS);
    void lease.done.then(() => this.controls.delete(lease.done));
    if (lease.child.connected) {
      lease.child.send({ type: "workspace-quiescence-retire", nonce: lease.nonce });
    }
    return lease.done;
  }

  private acquire(
    key: string,
    context: LeaseContext,
    operation: Extract<NodeWorkerWorkspaceQuiescenceInput, { action: "acquire" }>,
  ): Lease {
    const idle = this.idle?.key === key && !this.idle.exited ? this.idle : undefined;
    if (idle) {
      this.idle = undefined;
    }
    const ready = createDeferredCore();
    const done = createDeferredCore();
    const releaseWorkspace = context.retainWorkspace();
    let child: ChildProcess;
    try {
      // An idle helper must not hold a Windows directory lock on its released workspace.
      child =
        idle?.child ??
        spawn(
          process.execPath,
          workspaceQuiescenceArgv(context.workspaceDir, operation, "shared-host", "owned").slice(1),
          {
            cwd: path.dirname(process.execPath),
            env: context.env,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
    } catch (error) {
      releaseWorkspace();
      throw error;
    }
    const acquired: Lease = {
      key,
      context,
      nonce: operation.nonce,
      child,
      identity: idle?.identity,
      done: idle?.done ?? done.promise,
      operations: ready.promise,
      control: { action: "acquire", receipt: ready },
      acquisitionWaiters: 0,
      acknowledged: false,
      exited: false,
      released: false,
      releaseWorkspace,
    };
    this.leases.set(key, acquired);
    if (idle) {
      acquired.operations = this.control(acquired, operation);
    }
    void acquired.operations.catch(() => undefined);
    if (idle) {
      return acquired;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    child.stdout?.resume();
    const current = () => {
      const owner = this.leases.get(key) ?? this.idle;
      return owner?.child === child ? owner : acquired;
    };
    child.on("message", (message: unknown) => {
      const lease = current();
      if (!isRecord(message) || message.nonce !== lease.nonce) {
        return;
      }
      if (message.type === "workspace-quiescence-retired") {
        lease.control?.receipt.reject(
          new Error("workspace quiescence lease expired during control"),
        );
        lease.released = true;
        this.retire(lease);
      } else if (
        message.type === "workspace-quiescence-result" &&
        lease.control &&
        lease.control.action === message.action &&
        lease.control.id === message.id
      ) {
        const { receipt } = lease.control;
        lease.control = undefined;
        try {
          if (typeof message.error === "string") {
            throw new Error(message.error);
          }
          lease.identity ??= requireNodeWorkerProcessIdentity(child.pid!);
          receipt.resolve();
        } catch (error) {
          receipt.reject(error);
        }
      }
    });
    child.once("error", (error) => {
      stderr ||= error.message;
    });
    child.once("close", (code) => {
      const lease = current();
      lease.exited = true;
      if (this.idle === lease) {
        this.idle = undefined;
      }
      // Spawn refusal has no lease; failed expiry still requires explicit recovery.
      lease.released = !child.pid || (code === 0 && lease.released);
      lease.control?.receipt.reject(
        new Error(stderr || "workspace quiescence watchdog exited during control"),
      );
      this.retire(lease);
      done.resolve();
    });
    return acquired;
  }

  private release(lease: Lease): Promise<void> {
    lease.releasing ??= (async () => {
      await lease.operations.catch(() => undefined);
      if (this.leases.get(lease.key) === lease) {
        const operation = { action: "release", nonce: lease.nonce } as const;
        try {
          await this.control(lease, operation);
        } catch (error) {
          if (!lease.released) {
            if (!lease.exited) {
              throw error;
            }
            // A dead helper cannot acknowledge recovery; the standalone owner validates
            // and removes its empty lease without signalling any recorded PID.
            await this.runScript(lease.context, operation);
          }
        }
        lease.released = true;
        this.retire(lease);
      }
      if (this.closed) {
        await lease.done;
      }
    })().catch((error: unknown) => {
      lease.releasing = undefined;
      throw error;
    });
    return lease.releasing;
  }

  private async control(
    lease: Lease,
    operation: NodeWorkerWorkspaceQuiescenceInput,
  ): Promise<void> {
    this.assertActive(lease, operation.action === "release");
    const receipt = createDeferredCore();
    const id = randomUUID();
    lease.control = { id, action: operation.action, receipt };
    lease.child.send({ type: "workspace-quiescence-control", id, ...operation }, (error) => {
      if (error) {
        receipt.reject(error);
      }
    });
    return receipt.promise;
  }

  private async runScript(
    context: LeaseContext,
    operation: NodeWorkerWorkspaceQuiescenceInput,
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
    try {
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
      });
      const result = await run.wait();
      if (result.exitCode !== 0 || result.exitSignal !== null) {
        throw new Error(result.stderr || "workspace quiescence operation failed");
      }
      return result.stdout;
    } finally {
      await finishControl();
    }
  }
}
