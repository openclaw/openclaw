import { spawn, type ChildProcess, type SendHandle, type SpawnOptions } from "node:child_process";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { BrokerChild } from "./child.js";
import { terminateBrokerProcessGroup, terminateLostBrokerChild } from "./cleanup.js";
import type { BrokerExecaOptions, BrokerExecaResult } from "./execa-protocol.js";
import { createBrokerReceiver, createBrokerSender } from "./ipc.js";
import { holdPipe, restorePipePrefix, restoreStdinPipe } from "./pipe.js";
import {
  SpawnBrokerError,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerSpawnOptions,
} from "./protocol.js";

const spawnBrokerWorkerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spawnBroker);
export const spawnBrokerEntryPath = fileURLToPath(spawnBrokerWorkerUrl);

const MAX_REQUESTS = 256;
const RESTART_DELAYS = [100, 250, 500, 1000, 2000];

type Request = {
  child: BrokerChild;
  pid?: number;
  detached: boolean;
  result?: ReturnType<typeof createDeferredCore<BrokerExecaResult>>;
  childClosed: boolean;
  resultSettled: boolean;
};

export function brokerSpawnOptions(options: SpawnOptions): BrokerSpawnOptions | undefined {
  const stdio = options.stdio ?? "pipe";
  const entries = typeof stdio === "string" ? [stdio, stdio, stdio] : [...stdio];
  const normalized: BrokerSpawnOptions["stdio"] = [];
  for (let fd = 0; fd < Math.max(3, entries.length); fd += 1) {
    const entry = entries[fd] ?? (fd < 3 ? "pipe" : "ignore");
    // Only stdin is inherited by the broker. Numeric/anonymous descriptors stay host-owned.
    if (entry === "inherit" && fd !== 0) {
      return undefined;
    }
    if (entry !== "pipe" && entry !== "ignore" && entry !== "inherit" && entry !== "ipc") {
      return undefined;
    }
    normalized.push(entry);
  }
  if (options.signal || options.timeout || options.killSignal) {
    throw new Error("Unsupported spawn broker cancellation options");
  }
  return {
    cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
    env: options.env ? { ...options.env } : { ...process.env },
    argv0: options.argv0,
    detached: options.detached,
    shell: options.shell,
    windowsHide: options.windowsHide,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    serialization: options.serialization,
    uid: options.uid,
    gid: options.gid,
    stdio: normalized,
  };
}

export class SpawnBrokerHost {
  private process: ChildProcess | undefined;
  private sendMessage: ReturnType<typeof createBrokerSender> | undefined;
  private readiness = createDeferredCore();
  private available = false;
  private hasBeenReady = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private consecutiveFailures = 0;
  private sequence = 0;
  private requests = new Map<number, Request>();
  private readonly cleanups = new Set<ReturnType<typeof terminateLostBrokerChild>>();
  private readonly cleanupErrors: Error[] = [];
  private readonly onParentExit = () => {
    if (this.process?.connected) {
      this.process.disconnect();
    }
    for (const cleanup of this.cleanups) {
      cleanup.force();
    }
  };

  constructor(
    private readonly options: { onReady?: (pid: number, restarted: boolean) => void } = {},
  ) {
    void this.readiness.promise.catch(() => {});
    this.start();
    process.once("exit", this.onParentExit);
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }
  ready(): Promise<void> {
    return this.closing
      ? Promise.reject(new SpawnBrokerError("Spawn broker is closing"))
      : this.readiness.promise;
  }

  spawn(command: string, args: string[], options: SpawnOptions): BrokerChild {
    const prepared = brokerSpawnOptions(options);
    if (!prepared) {
      throw new Error("Unsupported spawn broker stdio or process options");
    }
    return this.admit({
      type: "spawn",
      id: ++this.sequence,
      argv: [command, ...args],
      options: prepared,
    }).child;
  }

  spawnExeca(argv: string[], options: BrokerExecaOptions) {
    const id = ++this.sequence;
    const request = this.admit({ type: "spawn-execa", id, argv, options });
    return {
      child: request.child,
      result: request.result!.promise,
      cancel: () => {
        void this.transmit({ type: "cancel", id }).catch((error: unknown) =>
          request.child.fail(toErrorObject(error, "Spawn broker cancellation delivery failed")),
        );
      },
    };
  }

  private admit(message: Extract<BrokerRequest, { type: "spawn" | "spawn-execa" }>): Request {
    const child = new BrokerChild(message.id, message.argv, (value, handle) =>
      this.transmit(value, handle),
    );
    const result =
      message.type === "spawn-execa" ? createDeferredCore<BrokerExecaResult>() : undefined;
    if (result) {
      void result.promise.catch(() => {});
    }
    const request = {
      child,
      result,
      childClosed: false,
      resultSettled: !result,
      detached:
        message.options.detached === true ||
        (message.type === "spawn-execa" && message.options.killDescendants === true),
    };
    const fail = (error: Error) => {
      result?.reject(error);
      child.fail(error);
    };
    if (!this.available || this.closing || this.requests.size >= MAX_REQUESTS) {
      child.markNotStarted();
      queueMicrotask(() => fail(new SpawnBrokerError("Spawn broker is unavailable")));
      return request;
    }
    this.requests.set(message.id, request);
    void child.waitForClose().then(() => {
      request.childClosed = true;
      this.retire(message.id, request);
    });
    void this.transmit(message).catch((error: unknown) => {
      this.requests.delete(message.id);
      fail(new SpawnBrokerError("Spawn broker request delivery failed", { cause: error }));
    });
    return request;
  }

  private retire(id: number, request: Request): void {
    if (request.childClosed && request.resultSettled) {
      this.requests.delete(id);
    }
  }

  private retainCleanup(cleanup: ReturnType<typeof terminateLostBrokerChild>): void {
    this.cleanups.add(cleanup);
    void cleanup.settled.then(
      () => this.cleanups.delete(cleanup),
      (failure: unknown) => {
        this.cleanupErrors.push(toErrorObject(failure, "Spawn broker cleanup failed"));
        this.cleanups.delete(cleanup);
      },
    );
  }

  private transmit(message: BrokerRequest, handle?: SendHandle): Promise<void> {
    if (!this.available || !this.sendMessage) {
      return Promise.reject(new SpawnBrokerError("Spawn broker is unavailable"));
    }
    return this.sendMessage(message, handle);
  }

  private start(): void {
    if (this.closing) {
      return;
    }
    const generation = this.generation++;
    const child = spawn(process.execPath, resolveRuntimeWorkerArgv(spawnBrokerWorkerUrl), {
      stdio: ["inherit", "ignore", "ignore", "ipc"],
      detached: true,
      serialization: "advanced",
    });
    this.process = child;
    this.sendMessage = createBrokerSender((message, handle, callback) =>
      child.send(message, handle, { keepOpen: true }, callback),
    );
    const receiver = createBrokerReceiver();
    const brokerExited = createDeferredCore();
    let ended = false;
    const startupTimer = setTimeout(() => {
      fail(new Error("readiness deadline exceeded after 15000ms"));
      child.kill("SIGKILL");
    }, 15_000);
    const fail = (cause?: Error) => {
      if (ended) {
        return;
      }
      ended = true;
      clearTimeout(startupTimer);
      receiver.clear();
      this.available = false;
      this.sendMessage = undefined;
      const error = new SpawnBrokerError(
        this.hasBeenReady
          ? "Spawn broker exited; command outcome is unavailable"
          : `Spawn broker failed before readiness: ${cause?.message ?? "channel lost"}`,
        { cause },
      );
      const previousReadiness = this.readiness;
      this.readiness = createDeferredCore();
      void this.readiness.promise.catch(() => {});
      previousReadiness.reject(error);
      for (const request of this.requests.values()) {
        if (request.pid && !request.childClosed) {
          const cleanup = terminateLostBrokerChild(
            request.pid,
            request.detached,
            this.closing ? brokerExited.promise : undefined,
          );
          this.retainCleanup(cleanup);
        }
        request.result?.reject(error);
        request.child.fail(error);
      }
      this.requests.clear();
      if (child.pid && process.platform !== "win32") {
        // Individual detached-tree escalation is armed before the broker group can die.
        this.retainCleanup(terminateBrokerProcessGroup(child.pid));
      }
      if (this.closing || !this.hasBeenReady) {
        this.readiness.reject(error);
        return;
      }
      const delay = RESTART_DELAYS[this.consecutiveFailures++];
      if (delay === undefined) {
        this.readiness.reject(error);
        return;
      }
      this.restartTimer = setTimeout(() => this.start(), delay);
    };
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      brokerExited.resolve();
      fail(new Error(`exited with code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
    child.once("disconnect", () => fail(new Error("IPC channel disconnected")));
    child.on("message", (raw: unknown, handle: unknown) => {
      if (ended || this.closing) {
        if (handle instanceof Socket) {
          handle.destroy();
        }
        return;
      }
      // The private child is the only sender; version-matched unions own validation.
      let decoded: unknown;
      try {
        decoded = receiver.receive(raw);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        if (child.connected) {
          child.disconnect();
        }
        child.kill("SIGTERM");
        return;
      }
      if (decoded === undefined) {
        return;
      }
      // SAFETY: The version-matched broker is the sole sender on this private IPC channel.
      const message = decoded as BrokerResponse;
      if (message.type === "ready") {
        clearTimeout(startupTimer);
        this.hasBeenReady = true;
        this.consecutiveFailures = 0;
        this.available = true;
        this.readiness.resolve();
        this.options.onReady?.(message.pid, generation > 0);
        return;
      }
      const request = this.requests.get(message.id);
      if (!request) {
        if (handle instanceof Socket) {
          handle.destroy();
        }
        if (message.type === "pipe") {
          void this.transmit({ type: "pipe-received", id: message.id, fd: message.fd }).catch(fail);
        }
        return;
      }
      if (message.type === "owned") {
        request.pid = message.pid;
      } else if (message.type === "pipe") {
        try {
          if (message.closed && message.fd === 0) {
            const stdin = new Socket();
            request.child.attachPipe(message.fd, stdin);
            stdin.destroy();
          } else if (handle instanceof Socket) {
            if (message.fd === 0) {
              restoreStdinPipe(handle);
            } else {
              holdPipe(handle);
            }
            request.child.attachPipe(message.fd, handle);
          } else {
            throw new SpawnBrokerError("Spawn broker pipe transfer failed");
          }
        } catch (error) {
          if (handle instanceof Socket) {
            handle.destroy();
          }
          fail(toErrorObject(error, "Spawn broker pipe setup failed"));
          if (child.connected) {
            child.disconnect();
          }
          child.kill("SIGTERM");
          return;
        }
        // The receipt follows Node's internal handle ACK on this same IPC channel.
        void this.transmit({ type: "pipe-received", id: message.id, fd: message.fd }).catch(fail);
      } else if (message.type === "pipe-prefix") {
        const pipe = request.child.stdio[message.fd];
        if (pipe instanceof Socket) {
          restorePipePrefix(pipe, message.bytes);
        }
      } else if (message.type === "execa-result") {
        // Started commands publish their owned PID first on this ordered channel.
        // A failed result without that admission is the worker's no-process outcome.
        if (request.pid === undefined && message.result.failed) {
          request.child.markNotStarted();
        }
        request.result?.resolve(message.result);
        request.resultSettled = true;
        this.retire(message.id, request);
      } else {
        if (message.type === "error" && message.resultUnavailable && request.result) {
          request.result.reject(Object.assign(new Error(message.error.message), message.error));
          request.resultSettled = true;
        }
        request.child.receive(message);
        this.retire(message.id, request);
      }
    });
  }

  /** Join cleanup already retained by this host, including recorded failures. */
  async waitForCleanup(): Promise<void> {
    await Promise.allSettled([...this.cleanups].map((cleanup) => cleanup.settled));
    if (this.cleanupErrors.length) {
      throw new AggregateError(this.cleanupErrors, "Spawn broker cleanup did not complete");
    }
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeInternal());
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    this.readiness.reject(new SpawnBrokerError("Spawn broker is closing"));
    clearTimeout(this.restartTimer);
    try {
      const child = this.process;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });
        if (child.connected) {
          child.disconnect();
        }
        const timer = setTimeout(() => child.kill("SIGKILL"), GRACEFUL_CANCEL_TIMEOUT_MS + 2000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      await this.waitForCleanup();
    } finally {
      process.removeListener("exit", this.onParentExit);
    }
  }
}

export function createSpawnBrokerHost(
  options?: ConstructorParameters<typeof SpawnBrokerHost>[0],
): SpawnBrokerHost {
  return new SpawnBrokerHost(options);
}
