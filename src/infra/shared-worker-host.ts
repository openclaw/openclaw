import { EventEmitter } from "node:events";
import {
  MessageChannel,
  receiveMessageOnPort,
  type MessagePort,
  type Transferable,
  type Worker,
  type WorkerOptions,
} from "node:worker_threads";
import {
  createRetainedOperation,
  type RetainedNativeWorker,
} from "@openclaw/worker-runtime/lifecycle";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getDatabaseEngineSelection } from "./database-engine/context.js";
import { getGatewayResourceProfile } from "./gateway-resource-profile.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "./runtime-worker-url.js";
import type {
  SharedWorkerHostKind,
  SharedWorkerHostReply,
  SharedWorkerHostRequest,
} from "./shared-worker-host.types.js";
import { trackSqliteDatabaseAdmissionWorker } from "./sqlite-database-admission.js";
import type { WorkerRetirementReason } from "./worker-cpu.js";
import {
  createCpuTrackedWorker,
  receiveWorkerMemoryPort,
  setTrackedWorkerHostedEndpoints,
} from "./worker-cpu.js";

const hostedEntrypoints = {
  "sqlite-store": runtimeProcessEntrypoints.sqliteStore,
  "session-transcript": runtimeProcessEntrypoints.sessionTranscript,
  "state-read": runtimeProcessEntrypoints.stateRead,
  "plugin-model-catalog-read": runtimeProcessEntrypoints.pluginModelCatalogRead,
} satisfies Record<SharedWorkerHostKind, unknown>;

// An idle endpoint that cannot acknowledge its stop has no other termination boundary.
const ENDPOINT_STOP_DEADLINE_MS = 10_000;

/** Owners stop an idle endpoint for these reasons; every other reason replaces the host. */
const logicalStopReasons = new Set<WorkerRetirementReason>([
  "idle_timeout",
  "idle-expiry",
  "rotation",
  "memory_pressure",
  "closed",
  "dispose",
  "shutdown",
]);

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.sharedWorkerHost"),
  (): { host?: SharedWorkerHost; nextEndpointId: number } => ({ nextEndpointId: 0 }),
);

function hostedKind(url: URL): SharedWorkerHostKind | undefined {
  for (const [kind, entrypoint] of Object.entries(hostedEntrypoints)) {
    // Retained update generations and sealed copies keep their own isolates.
    if (resolveRuntimeWorkerUrl(entrypoint).href === url.href) {
      // SAFETY: Keys come from the typed hostedEntrypoints table above.
      return kind as SharedWorkerHostKind;
    }
  }
  return undefined;
}

/**
 * Pure and synchronous: whether a new slot for this worker would run inside the shared host.
 * Only the lean profile hosts, at most one live endpoint per slot key, and never while a
 * failed host is still exiting, so at most one host isolate exists at a time.
 */
export function claimsSharedHostSlot(url: URL, key?: string): boolean {
  if (getGatewayResourceProfile()?.profile !== "lean") {
    return false;
  }
  const kind = hostedKind(url);
  if (!kind) {
    return false;
  }
  // The Postgres bridge binds one pool per isolate; hosted endpoints cannot share it.
  const engines = getDatabaseEngineSelection()?.effectiveEngines;
  if (engines && Object.values(engines).includes("postgres")) {
    return false;
  }
  const host = state.host;
  return !host || (!host.failure && !host.hasEndpoint(key ?? kind));
}

/** Callers check claimsSharedHostSlot first; this never falls back to a dedicated Worker. */
export function createHostedWorker(
  url: URL,
  options: Pick<WorkerOptions, "workerData" | "transferList">,
  { key, ready }: { key?: string; ready: boolean },
): HostedWorkerEndpoint {
  const kind = hostedKind(url);
  if (!kind) {
    throw new Error(`Worker ${url.href} cannot run in the shared worker host`);
  }
  state.host ??= new SharedWorkerHost();
  return new HostedWorkerEndpoint(state.host, kind, key ?? kind, options, ready);
}

export function isHostedWorkerEndpoint(worker: unknown): worker is HostedWorkerEndpoint {
  return worker instanceof HostedWorkerEndpoint;
}

class SharedWorkerHost {
  readonly worker: Worker;
  readonly control: MessagePort;
  readonly endpoints = new Map<number, HostedWorkerEndpoint>();
  failure?: Error;
  private servicing = false;

  constructor() {
    const { port1, port2 } = new MessageChannel();
    this.control = port1;
    const url = resolveRuntimeProcessEntrypointUrl("sharedWorkerHost");
    const selection = getDatabaseEngineSelection();
    this.worker = createCpuTrackedWorker(url, {
      env: resolveNodeCompileCacheEnv(),
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      workerData: { sharedWorkerHost: true, control: port2, databaseEngineSelection: selection },
      transferList: [port2],
      // The largest standalone member (SQLite store) uses the same bounded nursery.
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 16 },
    });
    // Hosted modules publish database admission facts under this one physical thread.
    trackSqliteDatabaseAdmissionWorker(this.worker);
    setTrackedWorkerHostedEndpoints(this.worker, () => this.endpoints.size);
    this.worker.on("message", (message: unknown) => {
      receiveWorkerMemoryPort(this.worker, message);
    });
    this.control.on("message", (reply: SharedWorkerHostReply) => this.receive(reply));
    this.control.unref();
    this.worker.unref();
    this.worker.on("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    this.worker.once("exit", (code) => {
      const failure =
        this.failure ?? new Error(`Shared worker host exited with code ${code ?? "unknown"}`);
      this.failure = failure;
      this.control.close();
      // Map iteration tolerates each endpoint removing itself.
      for (const endpoint of this.endpoints.values()) {
        endpoint.finish(code ?? 1, failure);
      }
      if (state.host === this) {
        state.host = undefined;
      }
    });
  }

  hasEndpoint(key: string): boolean {
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.key === key) {
        return true;
      }
    }
    return false;
  }

  send(request: SharedWorkerHostRequest, transferList: Transferable[] = []): void {
    this.control.postMessage(request, transferList);
  }

  /** Every hosted endpoint fails explicitly; the next claim starts a replacement host. */
  fail(cause: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = new Error(`Shared worker host failed: ${cause.message}`, { cause });
    void this.worker.terminate();
  }

  /** Release isolate-wide state physically once no endpoint remains. */
  releaseIfIdle(): void {
    if (this.endpoints.size === 0 && !this.failure) {
      this.failure = new Error("Shared worker host retired after its last endpoint stopped");
      // Exit clears the owner; until then claims refuse so only one host isolate exists.
      void this.worker.terminate();
    }
  }

  receive(reply: SharedWorkerHostReply): void {
    const endpoint = this.endpoints.get(reply.id);
    if (!endpoint) {
      return;
    }
    if (reply.type === "started") {
      endpoint.markStarted();
    } else if (reply.type === "stopped") {
      endpoint.finish(0);
      this.releaseIfIdle();
    } else if (reply.type === "failed") {
      this.fail(new Error(`${endpoint.kind} endpoint failed: ${reply.reason}`));
    }
  }

  /** Synchronous callers drain replies without returning to the event loop. */
  service(): void {
    if (this.servicing) {
      return;
    }
    this.servicing = true;
    try {
      let received;
      while ((received = receiveMessageOnPort(this.control))) {
        // SAFETY: Only the host worker writes this private control channel.
        this.receive(received.message as SharedWorkerHostReply);
      }
    } finally {
      this.servicing = false;
    }
  }
}

/**
 * A logical endpoint with its own port, admission and queue. It never claims to be a native
 * Worker: a graceful stop detaches it from the host, and any other stop replaces the host.
 */
export class HostedWorkerEndpoint extends EventEmitter implements RetainedNativeWorker {
  readonly id: number;
  started = false;
  executionStopped = false;
  executionExitCode?: number;
  terminalFailure?: Error;
  private readonly port: MessagePort;
  private readonly stopped = createRetainedOperation<void>(() => this.service());
  private stopRequested = false;
  private logicalStop = false;
  private physicalStop = false;
  private stopDeadline?: NodeJS.Timeout;

  constructor(
    private readonly host: SharedWorkerHost,
    readonly kind: SharedWorkerHostKind,
    readonly key: string,
    options: Pick<WorkerOptions, "workerData" | "transferList">,
    ready: boolean,
  ) {
    super();
    this.id = ++state.nextEndpointId;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.port.on("message", (message: unknown) => this.emit("message", message));
    this.port.on("messageerror", (error) => this.emit("messageerror", error));
    host.endpoints.set(this.id, this);
    host.send(
      { type: "attach", id: this.id, kind, port: port2, workerData: options.workerData, ready },
      [port2, ...(options.transferList ?? [])],
    );
  }

  get threadId(): number {
    return this.host.worker.threadId;
  }

  get performance(): Worker["performance"] {
    return this.host.worker.performance;
  }

  cpuUsage(...args: Parameters<Worker["cpuUsage"]>): ReturnType<Worker["cpuUsage"]> {
    return this.host.worker.cpuUsage(...args);
  }

  getHeapStatistics(): ReturnType<Worker["getHeapStatistics"]> {
    return this.host.worker.getHeapStatistics();
  }

  postMessage(value: unknown, transferList?: readonly Transferable[]): void {
    this.port.postMessage(value, transferList ? [...transferList] : []);
  }

  ref(): this {
    this.port.ref();
    return this;
  }

  unref(): this {
    this.port.unref();
    return this;
  }

  /**
   * Record why the owner is stopping this endpoint. Only an idle owner reason permits a logical
   * stop; cancellation, failure or an unknown reason keeps the physical termination boundary.
   */
  retiring(reason: WorkerRetirementReason): void {
    if (logicalStopReasons.has(reason)) {
      this.logicalStop = true;
    } else {
      this.physicalStop = true;
    }
  }

  markStarted(): void {
    this.started = true;
    this.emit("started");
  }

  service(): void {
    this.host.service();
    let received;
    while (!this.executionStopped && (received = receiveMessageOnPort(this.port))) {
      this.emit("message", received.message);
    }
  }

  stop() {
    if (!this.stopRequested && !this.executionStopped) {
      this.stopRequested = true;
      if (this.logicalStop && !this.physicalStop && !this.host.failure) {
        this.host.send({ type: "stop", id: this.id });
        this.stopDeadline = setTimeout(() => {
          this.host.fail(new Error(`${this.kind} endpoint did not stop`));
        }, ENDPOINT_STOP_DEADLINE_MS);
        this.stopDeadline.unref();
      } else {
        this.host.fail(new Error(`${this.kind} endpoint required physical termination`));
      }
    }
    return this.stopped.operation;
  }

  terminate(): Promise<void> {
    return this.stop().result;
  }

  finish(code: number, failure?: Error): void {
    if (this.executionStopped) {
      return;
    }
    clearTimeout(this.stopDeadline);
    this.executionStopped = true;
    this.executionExitCode = code;
    this.terminalFailure = failure;
    this.host.endpoints.delete(this.id);
    this.port.close();
    if (failure && this.listenerCount("error") > 0) {
      this.emit("error", failure);
    }
    this.emit("execution-exit", code);
    this.stopped.resolve();
    this.emit("exit", code);
  }
}
