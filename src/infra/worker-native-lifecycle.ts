import { AsyncLocalStorage } from "node:async_hooks";
import {
  MessageChannel,
  receiveMessageOnPort,
  SHARE_ENV,
  type MessagePort,
  type Worker,
  type WorkerOptions,
} from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  registerGlobalSingletonFinalResourceReset,
  resolveGlobalSingleton,
} from "../shared/global-singleton.js";
import { captureSqliteWorkerEnvironmentData } from "./bun-sqlite-library.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import {
  captureRuntimeWorkerSource,
  type RuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import { createCpuTrackedWorker, receiveWorkerMemoryPort } from "./worker-cpu.js";
import { NativeWorker } from "./worker-native-handle.js";
import type {
  NativeWorkerReply,
  NativeWorkerRuntime,
  NativeWorkerResourceDescriptor,
  NativeWorkerResourceConnection,
  RetainedNativeWorker,
} from "./worker-native-lifecycle.types.js";
import { nativePortIsOpen } from "./worker-native-port.js";

type NativeRuntime = NativeWorkerRuntime & {
  worker: Worker;
  port: MessagePort;
  handles: Map<number, NativeWorker>;
  close(): Promise<void>;
};

export type RetainedNativeWorkerSource = {
  create(
    filename: string | URL,
    options?: WorkerOptions,
    resource?: NativeWorkerResourceDescriptor,
  ): RetainedNativeWorker;
  captureResource(
    moduleUrl: URL,
    workerDataKey: string,
    input?: unknown,
    connect?: () => NativeWorkerResourceConnection,
  ): NativeWorkerResourceDescriptor;
  /** The domain joins admitted work and its resources before shared native cleanup. */
  retain(owner: object, closeOwner: () => Promise<void>): void;
};

type NativeSource = RetainedNativeWorkerSource & {
  moduleUrl: URL;
  runtimeGeneration?: RuntimeWorkerGeneration;
  runtime?: NativeRuntime;
  broker?: SpawnBrokerHost;
  brokerModuleUrl: URL;
  closing: boolean;
  close(): Promise<void>;
};

const lifetimeKey = Symbol.for("openclaw.nativeWorkerLifetimes");
const lifetime = resolveGlobalSingleton(
  lifetimeKey,
  (): {
    nextId: number;
    sources: WeakMap<RuntimeWorkerGeneration, NativeSource>;
    defaultSource?: NativeSource;
  } => ({
    nextId: 0,
    sources: new WeakMap(),
  }),
);
registerGlobalSingletonFinalResourceReset(lifetimeKey, async () => {
  await lifetime.defaultSource?.close();
});

function nativeRuntime(source: NativeSource): NativeRuntime {
  if (source.closing) {
    throw new Error("Native worker source is closing");
  }
  const existing = source.runtime;
  if (existing) {
    if (existing.failure) {
      throw existing.failure;
    }
    return existing;
  }
  return runInDetachedAsyncContext(() => {
    const { port1, port2 } = new MessageChannel();
    const url = source.moduleUrl;
    let worker: Worker;
    try {
      worker = createCpuTrackedWorker(url, {
        execArgv: resolveRuntimeWorkerThreadExecArgv(url),
        env: SHARE_ENV,
        workerData: { port: port2 },
        transferList: [port2],
      });
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
    const handles = new Map<number, NativeWorker>();
    const ownerJoined = createDeferredCore();
    void ownerJoined.promise.catch(() => undefined);
    let terminating = false;
    let nativeOwnerJoined = false;
    const retireSource = () => {
      if (!nativeOwnerJoined || handles.size > 0) {
        return;
      }
      source.runtime = undefined;
      if (source.runtimeGeneration) {
        if (lifetime.sources.get(source.runtimeGeneration) === source) {
          lifetime.sources.delete(source.runtimeGeneration);
        }
      } else if (lifetime.defaultSource === source) {
        lifetime.defaultSource = undefined;
      }
      void source.broker?.close().catch(ownerJoined.reject);
    };
    const terminateOwner = () => {
      if (terminating) {
        return;
      }
      terminating = true;
      worker.ref();
      port1.ref();
      try {
        void worker.terminate().catch(ownerJoined.reject);
      } catch (error) {
        ownerJoined.reject(error);
      }
    };
    const receive = (value: unknown) => {
      if (!isRecord(value) || typeof value.id !== "number" || typeof value.type !== "string") {
        return;
      }
      // SAFETY: The paired lifetime worker owns this envelope; child data is nested in message.value.
      handles.get(value.id)?.receive(value as NativeWorkerReply);
    };
    const runtime: NativeRuntime = {
      worker,
      port: port1,
      handles,
      service() {
        for (;;) {
          const next = receiveMessageOnPort(port1);
          if (!next) {
            break;
          }
          receive(next.message);
        }
        // Resource callbacks can add or retire handles during this pass.
        const resourceHandles = [...handles.values()];
        for (const handle of resourceHandles) {
          handle.serviceResource();
        }
        if (runtime.failure) {
          return;
        }
        let channelOpen: boolean;
        try {
          channelOpen = nativePortIsOpen(port1);
        } catch (error) {
          fail(new Error("Native worker lifetime channel observation failed", { cause: error }));
          terminateOwner();
          return;
        }
        if (!channelOpen) {
          // Channel loss rejects callers, but only the separate native receipt
          // releases Worker or child-process custody.
          fail(new Error("Native worker lifetime channel closed"));
          terminateOwner();
          return;
        }
        source.broker?.serviceNativeResources();
      },
      post(message, transfers = []) {
        if (runtime.failure) {
          throw runtime.failure;
        }
        port1.postMessage(message, [...transfers]);
      },
      resourceBroker() {
        return (source.broker ??= runInDetachedAsyncContext(() =>
          createSpawnBrokerHost({ nativeResources: true, workerUrl: source.brokerModuleUrl }),
        ));
      },
      refreshReference() {
        retireSource();
        if (source.closing && handles.size === 0 && !nativeOwnerJoined) {
          // A refused owner close can finish later through its original native handle.
          void runtime.close().catch(ownerJoined.reject);
          return;
        }
        for (const handle of handles.values()) {
          handle.refreshResourceReference();
        }
        if ([...handles.values()].some((handle) => handle.needsReference)) {
          worker.ref();
          port1.ref();
        } else {
          worker.unref();
          port1.unref();
        }
      },
      close() {
        if (handles.size) {
          return Promise.reject(new Error("Native worker execution owners have not joined"));
        }
        runtime.failure ??= new Error("Native worker lifetime owner is closing");
        terminateOwner();
        return ownerJoined.promise;
      },
    };
    const fail = (error: unknown) => {
      if (runtime.failure) {
        return;
      }
      runtime.failure = toErrorObject(error, "Native worker lifetime owner failed");
      for (const handle of handles.values()) {
        handle.ownerFailed(runtime.failure);
      }
    };
    port1.on("message", receive);
    port1.on("messageerror", (error) => {
      try {
        fail(error);
      } finally {
        // A broken control channel is not an exit; only the actual owner join releases custody.
        terminateOwner();
      }
    });
    worker.on("message", (message: unknown) => receiveWorkerMemoryPort(worker, message));
    worker.on("error", fail);
    worker.once("exit", () => {
      // Runtime teardown recursively joins descendant Workers. The extra turn also
      // observes Bun's own parent-side join after its close callback returns.
      setImmediate(() => {
        const error = runtime.failure ?? new Error("Native worker lifetime owner exited");
        runtime.failure = error;
        nativeOwnerJoined = true;
        source.closing = true;
        for (const handle of handles.values()) {
          handle.ownerJoined(error);
        }
        port1.close();
        // Keep capture pinned to this closing owner until its last actual resource join.
        retireSource();
        ownerJoined.resolve();
      });
    });
    source.runtime = runtime;
    runtime.refreshReference();
    return runtime;
  });
}

/** Capture before queues; explicit undefined preserves an intentionally unbound lifetime. */
export function captureRetainedNativeWorkerSource(options?: {
  runtimeGeneration?: RuntimeWorkerGeneration;
}): RetainedNativeWorkerSource {
  const supervisor = resolveRuntimeProcessEntrypointUrl("workerNativeLifecycle");
  const captured =
    options === undefined
      ? captureRuntimeWorkerSource(supervisor)
      : {
          moduleUrl: options.runtimeGeneration
            ? options.runtimeGeneration.resolve(supervisor)
            : supervisor,
          runtimeGeneration: options.runtimeGeneration,
        };
  const existing = captured.runtimeGeneration
    ? lifetime.sources.get(captured.runtimeGeneration)
    : lifetime.defaultSource;
  if (existing) {
    return existing;
  }
  const resources = new WeakSet<NativeWorkerResourceDescriptor>();
  const source: NativeSource = {
    ...captured,
    brokerModuleUrl: captured.runtimeGeneration
      ? captured.runtimeGeneration.resolve(resolveRuntimeProcessEntrypointUrl("spawnBroker"))
      : resolveRuntimeProcessEntrypointUrl("spawnBroker"),
    closing: false,
    close() {
      return (closingOwners ??= Promise.resolve().then(async () => {
        const closing = [...owners.values()].map((owner) => owner.close());
        joinSource();
        const results = await Promise.allSettled(closing.length ? closing : [joined.promise]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) {
          throw new AggregateError(errors, "Native worker execution owner cleanup failed");
        }
      }));
    },
    create(filename, workerOptions, resource) {
      if (captured.runtimeGeneration && !owners.size) {
        throw new Error("Native worker source has no retained execution owner");
      }
      if (resource && !resources.has(resource)) {
        throw new Error("Native worker resource belongs to a different execution source");
      }
      return startNativeWorker(nativeRuntime(source), filename, workerOptions ?? {}, resource);
    },
    captureResource(moduleUrl, workerDataKey, input, connect) {
      if (source.closing) {
        throw new Error("Native worker source is closing");
      }
      const inContext = AsyncLocalStorage.snapshot();
      const resource = Object.freeze({
        moduleUrl: String(captured.runtimeGeneration?.resolve(moduleUrl) ?? moduleUrl),
        workerDataKey,
        input: input === undefined ? undefined : structuredClone(input),
        connect: connect
          ? () =>
              inContext(() => {
                const connection = connect();
                const decode = connection.decodeCloseError?.bind(connection);
                const setReferenced = connection.setReferenced?.bind(connection);
                return {
                  port: connection.port,
                  service: () => inContext(() => connection.service()),
                  dispose: () => inContext(() => connection.dispose()),
                  setReferenced: setReferenced
                    ? (referenced: boolean) => inContext(() => setReferenced(referenced))
                    : undefined,
                  decodeCloseError: decode
                    ? (payload: unknown) => inContext(() => decode(payload))
                    : undefined,
                };
              })
          : undefined,
      });
      resources.add(resource);
      return resource;
    },
    retain(owner, closeOwner) {
      if (closingOwners || source.closing) {
        throw new Error("Native worker source is closing");
      }
      const close = async () => {
        let outcome: { status: "fulfilled" } | { status: "rejected"; error: unknown };
        try {
          await closeOwner();
          outcome = { status: "fulfilled" };
        } catch (error) {
          outcome = { status: "rejected", error };
        } finally {
          record.settled = true;
          joinSource();
        }
        try {
          await joined.promise;
        } catch (error) {
          if (outcome.status === "rejected") {
            throw new AggregateError(
              [outcome.error, error],
              "Execution owner and native source cleanup failed",
              { cause: error },
            );
          }
          throw error;
        }
        if (outcome.status === "rejected") {
          throw outcome.error;
        }
      };
      const record = { close, settled: false };
      captured.runtimeGeneration?.retain(owner, close);
      owners.set(owner, record);
    },
  };
  const owners = new Map<object, { close: () => Promise<void>; settled: boolean }>();
  const joined = createDeferredCore();
  void joined.promise.catch(() => undefined);
  let joining = false;
  let closingOwners: Promise<void> | undefined;
  const joinSource = () => {
    if (joining || [...owners.values()].some((owner) => !owner.settled)) {
      return;
    }
    joining = true;
    source.closing = true;
    void (async () => {
      await source.runtime?.close();
      await source.broker?.close();
      if (captured.runtimeGeneration) {
        if (lifetime.sources.get(captured.runtimeGeneration) === source) {
          lifetime.sources.delete(captured.runtimeGeneration);
        }
      } else if (lifetime.defaultSource === source) {
        lifetime.defaultSource = undefined;
      }
      owners.clear();
    })().then(joined.resolve, joined.reject);
  };
  if (captured.runtimeGeneration) {
    lifetime.sources.set(captured.runtimeGeneration, source);
  } else {
    lifetime.defaultSource = source;
  }
  return source;
}

/** Existing execution owners retain their queues; this capability owns only physical Worker lifetime. */
export function createRetainedNativeWorker(
  filename: string | URL,
  options: WorkerOptions = {},
  source: RetainedNativeWorkerSource = captureRetainedNativeWorkerSource({
    runtimeGeneration: undefined,
  }),
  resource?: NativeWorkerResourceDescriptor,
): RetainedNativeWorker {
  return source.create(filename, options, resource);
}

function startNativeWorker(
  runtime: NativeRuntime,
  filename: string | URL,
  options: WorkerOptions,
  resource?: NativeWorkerResourceDescriptor,
): RetainedNativeWorker {
  const id = ++lifetime.nextId;
  const resourceConnection = resource?.connect?.();
  const handle = new NativeWorker(
    runtime,
    id,
    filename,
    options.eval === true,
    resource !== undefined,
    resourceConnection,
  );
  const { env, transferList = [], ...captured } = options;
  runtime.handles.set(id, handle);
  try {
    const retainedResource = resource ? handle.attachResource(resource) : undefined;
    runtime.post(
      {
        type: "create",
        id,
        filename: { kind: filename instanceof URL ? "url" : "path", value: String(filename) },
        environmentData: captureSqliteWorkerEnvironmentData(),
        options: {
          ...captured,
          environment: { ...(env === SHARE_ENV ? process.env : (env ?? process.env)) },
          shareEnvironment: env === SHARE_ENV,
        },
        transferList: [...transferList],
        resource: retainedResource,
      },
      transferList,
    );
  } catch (error) {
    runtime.handles.delete(id);
    runtime.refreshReference();
    handle.abandonResource();
    throw error;
  }
  runtime.refreshReference();
  return handle;
}
