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
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
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
import { receiveWorkerMemoryPort, setTrackedWorkerHostedEndpoints } from "./worker-cpu.js";
import { createRetainedNativeWorker } from "./worker-native-lifecycle.js";

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
 * Only the lean profile hosts, only where explicit SQLite close releases native resources,
 * at most one live endpoint per slot key, and never while a failed host is still exiting,
 * so at most one host isolate exists at a time.
 */
export function claimsSharedHostSlot(url: URL, key?: string): boolean {
  if (getGatewayResourceProfile()?.profile !== "lean") {
    return false;
  }
  const kind = hostedKind(url);
  if (!kind) {
    return false;
  }
  // Without qualified native close, owners rotate so worker exit releases handles and locks;
  // a logical endpoint stop has no such exit, so these runtimes keep dedicated workers.
  if (!getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources) {
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
  /** Supervised, so synchronous callers can observe its exit through service(). */
  readonly worker: RetainedNativeWorker;
  readonly control: MessagePort;
  readonly endpoints = new Map<number, HostedWorkerEndpoint>();
  failure?: Error;
  private physicalStop?: RetainedOperation<void>;
  private servicing = false;

  constructor() {
    const { port1, port2 } = new MessageChannel();
    this.control = port1;
    const url = resolveRuntimeProcessEntrypointUrl("sharedWorkerHost");
    this.worker = createRetainedNativeWorker(url, {
      env: resolveNodeCompileCacheEnv(),
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      workerData: {
        sharedWorkerHost: true,
        control: port2,
        databaseEngineSelection: getDatabaseEngineSelection(),
      },
      transferList: [port2],
      // The largest standalone member (SQLite store) uses the same bounded nursery.
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 16 },
    });
    this.worker.on("started", () => {
      // Hosted modules publish database admission facts under this one physical thread.
      trackSqliteDatabaseAdmissionWorker(this.worker);
      setTrackedWorkerHostedEndpoints(this.worker, () => this.endpoints.size);
    });
    this.worker.on("message", (message: unknown) => {
      receiveWorkerMemoryPort(this.worker, message);
    });
    this.control.on("message", (reply: SharedWorkerHostReply) => this.receive(reply));
    this.control.unref();
    this.worker.unref();
    this.worker.on("error", (error) => {
      this.fail(error);
      // A refused constructor has no native Worker and no exit event to join.
      this.observePhysicalStop();
    });
    // Execution exit is observable synchronously; live endpoints fail before the join.
    this.worker.on("execution-exit", (code) => {
      this.failure ??= new Error(`Shared worker host exited with code ${code ?? "unknown"}`);
      this.control.close();
      // Map iteration tolerates each endpoint removing itself.
      for (const endpoint of this.endpoints.values()) {
        if (!endpoint.awaitingHostJoin) {
          endpoint.finish(code ?? 1, this.failure);
        }
      }
    });
    this.worker.once("exit", (code) => this.joined(code));
  }

  /** Physical join: the last logically stopped endpoint settles only now. */
  private joined(code: number | undefined): void {
    this.failure ??= new Error("Shared worker host exited");
    this.control.close();
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.awaitingHostJoin) {
        endpoint.finish(0);
      } else {
        endpoint.finish(code ?? 1, this.failure);
      }
    }
    if (state.host === this) {
      state.host = undefined;
    }
  }

  private stopPhysically(): void {
    if (this.physicalStop) {
      return;
    }
    const stopping = this.worker.stop();
    this.physicalStop = stopping;
    void stopping.result.then(
      () => this.observePhysicalStop(),
      () => this.observePhysicalStop(),
    );
  }

  /** Native stop outcomes are retained, so synchronous callers see them through service(). */
  private observePhysicalStop(): void {
    const outcome = this.physicalStop?.read();
    if (!outcome || outcome.status === "pending") {
      return;
    }
    if (outcome.status === "fulfilled") {
      this.joined(this.worker.executionExitCode);
      return;
    }
    // The supervisor could not confirm exit: stops fail without claiming a join; a retry restarts.
    this.physicalStop = undefined;
    for (const endpoint of this.endpoints.values()) {
      endpoint.rejectStop(outcome.error);
    }
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
    this.failure ??= new Error(`Shared worker host failed: ${cause.message}`, { cause });
    this.stopPhysically();
  }

  receive(reply: SharedWorkerHostReply): void {
    const endpoint = this.endpoints.get(reply.id);
    if (!endpoint) {
      return;
    }
    if (reply.type === "started") {
      endpoint.markStarted();
    } else if (reply.type === "stopped") {
      if (this.endpoints.size > 1 || this.failure) {
        endpoint.finish(0);
        return;
      }
      // The last endpoint's retirement joins the physical host, releasing isolate-wide state.
      // Until then claims refuse, so only one host isolate exists.
      endpoint.awaitingHostJoin = true;
      this.failure = new Error("Shared worker host retired after its last endpoint stopped");
      this.stopPhysically();
    } else if (reply.type === "failed") {
      this.fail(new Error(`${endpoint.kind} endpoint failed: ${reply.reason}`));
    }
  }

  /** Synchronous callers observe replies, overdue stops and physical exit without the event loop. */
  service(): void {
    if (this.servicing) {
      return;
    }
    this.servicing = true;
    try {
      this.worker.service();
      this.observePhysicalStop();
      let received;
      while (!this.failure && (received = receiveMessageOnPort(this.control))) {
        // SAFETY: Only the host worker writes this private control channel.
        this.receive(received.message as SharedWorkerHostReply);
      }
      const now = performance.now();
      for (const endpoint of this.endpoints.values()) {
        if (endpoint.stopDeadlineAt !== undefined && now >= endpoint.stopDeadlineAt) {
          this.fail(new Error(`${endpoint.kind} endpoint did not stop`));
        }
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
  private stopped = createRetainedOperation<void>(() => this.service());
  private stopRequested = false;
  awaitingHostJoin = false;
  private logicalStop = false;
  private physicalStop = false;
  private stopDeadline?: NodeJS.Timeout;
  stopDeadlineAt?: number;

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

  /** The supervised host exposes no event-loop utilization to the main thread. */
  readonly performance = undefined;

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
    const status = this.stopped.operation.read().status;
    if (status === "rejected" || (this.executionStopped && status !== "fulfilled")) {
      this.stopped = createRetainedOperation<void>(() => this.service());
      if (this.executionStopped) {
        // A retry after the physical join has nothing left to stop.
        this.stopped.resolve();
      }
    }
    if (!this.stopRequested && !this.executionStopped) {
      this.stopRequested = true;
      if (this.logicalStop && !this.physicalStop && !this.host.failure) {
        // An idle pool unreferenced this port; the pending stop keeps the process alive.
        this.port.ref();
        this.host.send({ type: "stop", id: this.id });
        this.stopDeadlineAt = performance.now() + ENDPOINT_STOP_DEADLINE_MS;
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

  /** The host could not confirm physical exit; a later stop retries it. */
  rejectStop(error: unknown): void {
    if (!this.executionStopped) {
      this.stopRequested = false;
      this.stopped.reject(error);
    }
  }

  terminate(): Promise<void> {
    return this.stop().result;
  }

  finish(code: number, failure?: Error): void {
    if (this.executionStopped) {
      return;
    }
    clearTimeout(this.stopDeadline);
    this.stopDeadlineAt = undefined;
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
