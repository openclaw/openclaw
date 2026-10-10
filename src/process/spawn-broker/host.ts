import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess, type SendHandle, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { formatChildRuntimeSpawnWarning } from "../../infra/child-runtime-viability.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SpawnInitiation } from "../spawn-initiation.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { getSpawnBrokerAdmission } from "./admission.js";
import { BrokerChild } from "./child.js";
import { terminateBrokerProcessGroup, terminateLostBrokerChild } from "./cleanup.js";
import type { BrokerExecaOptions, BrokerExecaResult } from "./execa-protocol.js";
import { createBrokerReceiver, createBrokerSender } from "./ipc.js";
import { holdPipe, restoreStdinPipe } from "./pipe.js";
import {
  childCapacityError,
  type BrokerAdmission,
  MAX_NATIVE_RESOURCES,
  MAX_PENDING_SPAWNS,
  SpawnBrokerError,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerSpawnOptions,
} from "./protocol.js";
import { createNativeResourceDirectory } from "./resource-directory.js";
import {
  BrokerResourceClaims,
  type BrokerNativeResourceCallbacks,
  type BrokerNativeResourceInput,
  type BrokerNativeResourceLease,
} from "./resource-host.js";
import {
  SPAWN_BROKER_STARTUP_TIMEOUT_MS,
  spawnBrokerStartupNowMs,
  type BrokerBootstrap,
  type BrokerResourceRequest,
  type BrokerResourceResponse,
} from "./resource-protocol.js";

export type { BrokerNativeResourceLease } from "./resource-host.js";

const RESTART_DELAYS = [100, 250, 500, 1000, 2000];
const MAX_BOOTSTRAP_BYTES = 1024;

type Request = {
  child: BrokerChild;
  initiateSpawn?: SpawnInitiation;
  nativeInitiated?: ReturnType<typeof createDeferredCore<void>>;
  pid?: number;
  detached: boolean;
  result?: ReturnType<typeof createDeferredCore<BrokerExecaResult>>;
  childClosed: boolean;
  resultSettled: boolean;
  recovering?: boolean;
  nativeClosed?: boolean;
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
  readonly entryPath: string;
  private readonly workerUrl: URL;
  private readonly runInContext = AsyncLocalStorage.snapshot();
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
  private readonly childAdmissions = new Map<number, BrokerAdmission>();
  private readonly pendingSpawns = new Set<number>();
  private readonly cleanups = new Set<ReturnType<typeof terminateLostBrokerChild>>();
  private readonly cleanupErrors: Error[] = [];
  private readonly resourceClaims: BrokerResourceClaims | undefined;
  private readonly resourceDirectory: string | undefined;
  private readonly resourceAuthority: { endpoint: string; secret: string } | undefined;
  private startupDeadline = 0;
  private serviceStartup: (() => void) | undefined;
  private markNativeReady: ((pid: number, generation: number) => void) | undefined;
  private brokerClosed: Promise<void> | undefined;
  private readonly onParentExit = () => {
    if (this.process?.connected) {
      this.process.disconnect();
    }
    for (const cleanup of this.cleanups) {
      cleanup.force();
    }
  };

  constructor(
    private readonly options: {
      onReady?: (pid: number, restarted: boolean) => void;
      workerUrl?: URL;
      nativeResources?: true;
    } = {},
  ) {
    this.workerUrl =
      options.workerUrl ?? resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spawnBroker);
    this.entryPath = fileURLToPath(this.workerUrl);
    if (options.nativeResources) {
      this.resourceDirectory = createNativeResourceDirectory();
      const secret = randomBytes(32).toString("hex");
      this.resourceAuthority = {
        secret,
        endpoint:
          process.platform === "win32"
            ? `\\\\.\\pipe\\oc-br-${secret}`
            : join(this.resourceDirectory, "resource.sock"),
      };
      this.resourceClaims = new BrokerResourceClaims({
        transmit: async (request) => {
          if (!this.available) {
            await this.ready();
          }
          await this.transmit(request);
        },
        markReady: (pid, generation) => {
          if (!this.markNativeReady) {
            throw new SpawnBrokerError("Native resource broker unavailable");
          }
          this.markNativeReady(pid, generation);
        },
        refreshReference: () => this.refreshNativeReference(),
      });
    }
    void this.readiness.promise.catch(() => {});
    try {
      this.start();
    } catch (error) {
      if (this.resourceDirectory) {
        rmSync(this.resourceDirectory, { recursive: true, force: true });
      }
      throw error;
    }
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

  captureNativeResource(
    input: BrokerNativeResourceInput,
    callbacks: BrokerNativeResourceCallbacks,
  ): BrokerNativeResourceLease {
    if (
      !this.resourceClaims ||
      !this.resourceAuthority ||
      this.closing ||
      this.resourceClaims.size >= MAX_NATIVE_RESOURCES
    ) {
      throw new SpawnBrokerError("Native resource broker is unavailable or at capacity");
    }
    return this.resourceClaims.capture(
      {
        ...input,
        ...this.resourceAuthority,
        generation: this.generation - 1,
        startupDeadline: this.available ? undefined : this.startupDeadline,
        id: ++this.sequence,
      },
      callbacks,
    );
  }

  sealNativeResources(): Promise<void> {
    if (this.resourceClaims && !this.available) {
      return Promise.reject(
        new SpawnBrokerError("Native resource broker is not ready for cleanup"),
      );
    }
    return (
      this.resourceClaims?.seal() ??
      Promise.reject(new SpawnBrokerError("Native resources are disabled"))
    );
  }

  serviceNativeResources(): void {
    this.serviceStartup?.();
  }

  private refreshNativeReference(): void {
    if (!this.resourceClaims || !this.process) {
      return;
    }
    if (this.closing || this.resourceClaims.hasOpenClaims || this.requests.size > 0) {
      this.process.ref();
      // Newer Bun releases, like Node, reference IPC independently of the child.
      this.process.channel?.ref?.();
    } else {
      this.process.unref();
      this.process.channel?.unref?.();
    }
  }

  spawn(
    command: string,
    args: string[],
    options: SpawnOptions,
    initiateSpawn?: SpawnInitiation,
  ): BrokerChild {
    const prepared = brokerSpawnOptions(options);
    if (!prepared) {
      throw new Error("Unsupported spawn broker stdio or process options");
    }
    return this.admit(
      {
        type: initiateSpawn ? "prepare-spawn" : "spawn",
        id: ++this.sequence,
        argv: [command, ...args],
        options: prepared,
      },
      initiateSpawn,
    ).child;
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

  private admit(
    message: Extract<BrokerRequest, { type: "spawn" | "prepare-spawn" | "spawn-execa" }>,
    initiateSpawn?: SpawnInitiation,
  ): Request {
    message.admission = getSpawnBrokerAdmission();
    const capacityError = childCapacityError(this.childAdmissions.values(), message.admission);
    const child = new BrokerChild(message.id, message.argv, (value, handle, initiate) =>
      this.transmit(value, handle, initiate),
    );
    const result =
      message.type === "spawn-execa" ? createDeferredCore<BrokerExecaResult>() : undefined;
    if (result) {
      void result.promise.catch(() => {});
    }
    const request: Request = {
      child,
      initiateSpawn,
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
    if (
      !this.available ||
      this.closing ||
      this.pendingSpawns.size >= MAX_PENDING_SPAWNS ||
      capacityError
    ) {
      child.markNotStarted();
      queueMicrotask(() =>
        fail(
          new SpawnBrokerError(
            this.available && !this.closing
              ? (capacityError ?? "Spawn broker startup capacity exceeded")
              : "Spawn broker is unavailable",
          ),
        ),
      );
      return request;
    }
    this.childAdmissions.set(message.id, message.admission);
    this.requests.set(message.id, request);
    this.pendingSpawns.add(message.id);
    this.refreshNativeReference();
    void child.waitForClose().then(() => {
      request.childClosed = true;
      this.retire(message.id, request);
    });
    void this.transmit(message).catch((error: unknown) => {
      this.pendingSpawns.delete(message.id);
      if (!request.nativeInitiated && message.type === "prepare-spawn") {
        child.markNotStarted();
      }
      // Delivery failure is not proof that an ordinary launch never reached its peer.
      fail(new SpawnBrokerError("Spawn broker request delivery failed", { cause: error }));
    });
    return request;
  }

  private retire(id: number, request: Request): void {
    if (request.childClosed && request.resultSettled && !request.nativeInitiated) {
      if (request.child.notStarted || (!request.recovering && request.nativeClosed)) {
        this.childAdmissions.delete(id);
      } else if (!request.recovering || request.pid === undefined) {
        return;
      }
      this.requests.delete(id);
      this.refreshNativeReference();
    }
  }

  private retainCleanup(cleanup: ReturnType<typeof terminateLostBrokerChild>, id?: number): void {
    this.cleanups.add(cleanup);
    void cleanup.settled.then(
      () => {
        this.cleanups.delete(cleanup);
        if (id !== undefined) {
          this.childAdmissions.delete(id);
        }
      },
      (failure: unknown) => {
        this.cleanupErrors.push(toErrorObject(failure, "Spawn broker cleanup failed"));
        this.cleanups.delete(cleanup);
      },
    );
  }

  private transmit(
    message: BrokerRequest | Exclude<BrokerResourceRequest, { type: "resource-attach" }>,
    handle?: SendHandle,
    initiateSpawn?: SpawnInitiation,
  ): Promise<void> {
    if (!this.available || !this.sendMessage) {
      return Promise.reject(new SpawnBrokerError("Spawn broker is unavailable"));
    }
    return this.sendMessage(message, handle, initiateSpawn);
  }

  private start(): void {
    if (this.closing) {
      return;
    }
    const generation = this.generation++;
    const bootstrap: BrokerBootstrap = {
      type: "bootstrap",
      ...(this.resourceAuthority
        ? { nativeResource: { ...this.resourceAuthority, generation } }
        : {}),
    };
    if (serialize(bootstrap).byteLength > MAX_BOOTSTRAP_BYTES) {
      throw new SpawnBrokerError("Spawn broker bootstrap exceeds its IPC bound");
    }
    // Native resource modules and bidirectional V8 frames require the parent's exact runtime.
    const child = spawn(process.execPath, resolveRuntimeWorkerArgv(this.workerUrl), {
      stdio: ["inherit", "ignore", "ignore", "ipc"],
      detached: true,
      serialization: "advanced",
    });
    this.process = child;
    this.brokerClosed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    const receiver = createBrokerReceiver();
    const brokerExited = createDeferredCore();
    let ended = false;
    let ready = false;
    this.startupDeadline = spawnBrokerStartupNowMs() + SPAWN_BROKER_STARTUP_TIMEOUT_MS;
    const checkStartup = () => {
      if (!ended && !ready && spawnBrokerStartupNowMs() >= this.startupDeadline) {
        fail(new Error("readiness deadline exceeded after 15000ms"));
        child.kill("SIGKILL");
      }
    };
    // Native attachments report readiness off-main; a delayed parent callback is not failure.
    const startupTimer = this.resourceClaims
      ? undefined
      : setTimeout(checkStartup, SPAWN_BROKER_STARTUP_TIMEOUT_MS);
    this.serviceStartup = checkStartup;
    const fail = (cause?: Error) => {
      if (ended) {
        return;
      }
      ended = true;
      clearTimeout(startupTimer);
      this.markNativeReady = undefined;
      receiver.clear();
      this.available = false;
      this.sendMessage = undefined;
      const error = new SpawnBrokerError(
        formatChildRuntimeSpawnWarning(cause) ??
          (this.hasBeenReady
            ? "Spawn broker exited; command outcome is unavailable"
            : `Spawn broker failed before readiness: ${cause?.message ?? "channel lost"}`),
        { cause },
      );
      const previousReadiness = this.readiness;
      this.readiness = createDeferredCore();
      void this.readiness.promise.catch(() => {});
      previousReadiness.reject(error);
      for (const [id, request] of this.requests) {
        request.recovering = true;
        if (request.pid && !request.nativeClosed) {
          const cleanup = terminateLostBrokerChild(
            request.pid,
            request.detached,
            this.closing ? brokerExited.promise : undefined,
          );
          this.retainCleanup(cleanup, id);
        } else if (request.child.notStarted || request.nativeClosed) {
          this.childAdmissions.delete(id);
        }
        // Unknown detached launches retain their reservation across broker restarts.
        request.result?.reject(error);
        request.child.fail(error);
      }
      this.requests.clear();
      this.pendingSpawns.clear();
      this.refreshNativeReference();
      if (child.pid && process.platform !== "win32") {
        // Individual detached-tree escalation is armed before the broker group can die.
        this.retainCleanup(terminateBrokerProcessGroup(child.pid));
      }
      if (this.resourceClaims || this.closing || !this.hasBeenReady) {
        this.readiness.reject(error);
        this.resourceClaims?.fail(error);
        return;
      }
      const delay = RESTART_DELAYS[this.consecutiveFailures++];
      if (delay === undefined) {
        this.readiness.reject(error);
        return;
      }
      this.restartTimer = setTimeout(() => this.start(), delay);
    };
    const markReady = (pid: number, receivedGeneration: number) => {
      if (ended || pid !== child.pid || receivedGeneration !== generation) {
        throw new SpawnBrokerError("Native resource readiness does not match the captured broker");
      }
      if (ready) {
        return;
      }
      ready = true;
      clearTimeout(startupTimer);
      this.hasBeenReady = true;
      this.consecutiveFailures = 0;
      this.available = true;
      this.readiness.resolve();
      this.runInContext(() => this.options.onReady?.(pid, generation > 0));
    };
    this.markNativeReady = markReady;
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      brokerExited.resolve();
      fail(new Error(`exited with code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
    child.once("disconnect", () => fail(new Error("IPC channel disconnected")));
    const abortTransport = (error: Error) => {
      fail(error);
      if (!this.resourceClaims && child.connected) {
        child.disconnect();
      }
      child.kill("SIGTERM");
    };
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
        abortTransport(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (decoded === undefined) {
        return;
      }
      // SAFETY: The version-matched broker is the sole sender on this private IPC channel.
      const message = decoded as BrokerResponse | BrokerResourceResponse;
      if (message.type === "ready") {
        markReady(message.pid, generation);
        return;
      }
      if (
        message.type === "resource-ready" ||
        message.type === "resource-created" ||
        message.type === "resource-target" ||
        message.type === "resource-owner" ||
        message.type === "resource-owner-received" ||
        message.type === "resource-owner-rejected" ||
        message.type === "resource-closed" ||
        message.type === "resource-close-error" ||
        message.type === "resource-failed"
      ) {
        this.resourceClaims?.receive(message);
        return;
      }
      if (message.type === "spawned" || message.type === "error") {
        this.pendingSpawns.delete(message.id);
      }
      const request = this.requests.get(message.id);
      if (!request) {
        if (handle instanceof Socket) {
          handle.destroy();
        }
        if (message.type === "pipe") {
          void this.transmit({ type: "pipe-received", id: message.id, fd: message.fd }).catch(fail);
        } else if (message.type === "prepared") {
          void this.transmit({ type: "launch", id: message.id, allowed: false }).catch(
            abortTransport,
          );
        }
        return;
      }
      if (message.type === "owned" || message.type === "error") {
        request.nativeInitiated?.resolve();
        request.nativeInitiated = undefined;
      }
      if (message.type === "prepared") {
        const initiate = request.initiateSpawn;
        request.initiateSpawn = undefined;
        const brokerClosed = this.brokerClosed;
        const nativeInitiated = initiate
          ? (request.nativeInitiated ??= createDeferredCore())
          : undefined;
        // Local proxy failure is not native settlement; only this peer's receipt or exit is proof.
        const settlement =
          brokerClosed && nativeInitiated
            ? Promise.race([nativeInitiated.promise, brokerClosed])
            : Promise.reject(new Error("Spawn broker retirement is unavailable"));
        void settlement.catch(() => {});
        void this.transmit(
          { type: "launch", id: message.id, allowed: true },
          undefined,
          (launch) => {
            if (!initiate || !nativeInitiated || request.childClosed) {
              throw new SpawnBrokerError("Spawn broker launch grant is unavailable");
            }
            return initiate(launch, settlement);
          },
        ).catch(() => {
          void this.transmit({ type: "launch", id: message.id, allowed: false }).catch(fail);
        });
      } else if (message.type === "owned") {
        request.pid = message.pid;
        if (request.childClosed) {
          request.recovering = true;
          this.retainCleanup(terminateLostBrokerChild(message.pid, request.detached), message.id);
          this.retire(message.id, request);
        }
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
          abortTransport(toErrorObject(error, "Spawn broker pipe setup failed"));
          return;
        }
        // The receipt follows Node's internal handle ACK on this same IPC channel.
        void this.transmit({ type: "pipe-received", id: message.id, fd: message.fd }).catch(fail);
      } else if (message.type === "pipe-prefix") {
        const pipe = request.child.stdio[message.fd];
        if (pipe instanceof Socket && message.bytes.length > 0) {
          pipe.unshift(message.bytes);
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
        if (message.type === "closed") {
          request.nativeClosed = true;
        } else if (message.type === "error" && message.notStarted) {
          request.child.markNotStarted();
        }
        if (message.type === "error" && message.resultUnavailable && request.result) {
          request.result.reject(Object.assign(new Error(message.error.message), message.error));
          request.resultSettled = true;
        }
        request.child.receive(message);
        this.retire(message.id, request);
      }
    });
    // Bootstrap must enter native IPC before a synchronous caller blocks Promise reactions.
    // Its send receipt is not readiness; the child reports readiness after initialization.
    try {
      child.send(bootstrap, (error) => {
        if (error) {
          abortTransport(error);
        }
      });
    } catch (error) {
      abortTransport(toErrorObject(error, "Spawn broker bootstrap delivery failed"));
    }
    if (!ended) {
      this.sendMessage = createBrokerSender((message, handle, callback) =>
        child.send(message, handle, { keepOpen: true }, callback),
      );
    }
    this.refreshNativeReference();
  }

  /** Join cleanup already retained by this host, including recorded failures. */
  async waitForCleanup(): Promise<void> {
    await Promise.allSettled([...this.cleanups].map((cleanup) => cleanup.settled));
    if (this.cleanupErrors.length) {
      throw new AggregateError(this.cleanupErrors, "Spawn broker cleanup did not complete");
    }
  }

  close(): Promise<void> {
    if (this.resourceClaims?.hasOpenClaims) {
      return Promise.reject(
        new SpawnBrokerError("Native resource claims must close before broker shutdown"),
      );
    }
    return (this.closePromise ??= this.closeInternal());
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    this.refreshNativeReference();
    this.readiness.reject(new SpawnBrokerError("Spawn broker is closing"));
    clearTimeout(this.restartTimer);
    try {
      const child = this.process;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited =
          this.resourceClaims && this.brokerClosed
            ? this.brokerClosed
            : new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
              });
        const timer = setTimeout(() => child.kill("SIGKILL"), GRACEFUL_CANCEL_TIMEOUT_MS + 2000);
        try {
          if (this.resourceClaims) {
            // Keep IPC readable until EOF: explicit disconnect can suppress Node's close event.
            void this.transmit({ type: "shutdown" }).catch(() => child.kill("SIGTERM"));
          } else if (child.connected) {
            child.disconnect();
          }
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        await this.waitForCleanup();
      } finally {
        if (this.resourceClaims) {
          await this.brokerClosed;
          if (this.resourceDirectory) {
            rmSync(this.resourceDirectory, { recursive: true, force: true });
          }
        }
      }
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
