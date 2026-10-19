import path from "node:path";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  captureRetainedNativeWorkerSource,
  type RetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { resolveActivePluginInstallRoots } from "./install-root-context.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { GenerationCodec } from "./plugin-generation-worker-codec.js";
import type {
  GenerationWorkerInput,
  GenerationWorkerReply,
  GenerationWorkerCallback,
} from "./plugin-generation-worker-contract.js";
import { PluginSourceRecoveryUnavailableError } from "./plugin-instance-error.js";
import {
  adoptPluginNativeAdmissions,
  nativeAdmissionStateFor,
  type PluginNativeAdmissionTransfer,
} from "./plugin-native-admission-state.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import { resolvePluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { createPluginSourceCaptureRoot } from "./plugin-source-capture-directory.js";
import { subscribePluginNativeLoads } from "./plugin-source-capture-native-loads.js";

export type PreparedPluginGenerationArtifact = {
  artifact: PluginGenerationArtifact;
  attachModuleSource(callback: (filename: string) => string): void;
};
type PreparationParameters = { rootDir: string; source: string; standalone?: boolean };
type PreparationOwner = { closing: boolean; clients: Set<() => Promise<void>> };
const preparationOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginPreparationOwners"),
  () => new WeakMap<RetainedNativeWorkerSource, PreparationOwner>(),
);

function preparationOwnerFor(source: RetainedNativeWorkerSource): PreparationOwner {
  let owner = preparationOwners.get(source);
  if (!owner) {
    owner = { closing: false, clients: new Set() };
    preparationOwners.set(source, owner);
    const retained = owner;
    source.retain(owner, async () => {
      retained.closing = true;
      const outcomes = await Promise.allSettled([...retained.clients].map((close) => close()));
      const errors = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Plugin preparation workers failed to close");
      }
    });
  }
  if (owner.closing) {
    throw new Error("Plugin preparation owner is closing");
  }
  return owner;
}

/** Each exposed artifact owns its capture worker; registry instance caching owns reuse. */
export async function preparePluginGenerationArtifact(
  params: PreparationParameters,
): Promise<PreparedPluginGenerationArtifact> {
  const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const owner = preparationOwnerFor(nativeSource);
  const storage = resolvePluginSourceCaptureStorage();
  const installRoots = resolveActivePluginInstallRoots();
  const publishAdmission = createPluginSourceAdmissionPublisher({
    stateDir: installRoots.stateDir,
  });
  const readOnly = isArtifactPreservingStateRead();
  const admission = nativeAdmissionStateFor();
  const admissionRoot = path.resolve(params.rootDir);
  const admissionOwner = admission.owners.get(admissionRoot);
  const root = createPluginSourceCaptureRoot(
    storage.stateDir,
    "plugin-preparation-",
    storage.placement,
  );
  let releasedRoot: Promise<void> | undefined;
  const releaseRoot = () => (releasedRoot ??= root.release());
  const { port1, port2 } = new MessageChannel();
  let moduleSource: ((filename: string) => string) | undefined;
  let resources = 0;
  let pending = 0;
  let drained: ReturnType<typeof createDeferredCore<void>> | undefined;
  let closing: Promise<void> | undefined;
  const pendingNativeLoads = new Set<string>();
  const waitSignal = new Int32Array(new SharedArrayBuffer(4));
  const pool = createOwnedWorkerTaskPool<GenerationWorkerInput, GenerationWorkerReply>(
    {
      workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.pluginGenerationPreparation),
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      prepareWorker: () => ({ options: {}, releaseResources: releaseRoot }),
    },
    { retainedTransport: true, nativeSource },
  );
  const stopObserving = subscribePluginNativeLoads((filename) => {
    if (!closing) {
      pendingNativeLoads.add(filename);
    }
  });
  function callback(message: GenerationWorkerCallback): void {
    if (message.kind === "publish") {
      void Promise.resolve()
        .then(() => publishAdmission?.(message.publication) ?? false)
        .then(
          (accepted) =>
            port1.postMessage({
              kind: "published",
              id: message.id,
              accepted,
            } satisfies GenerationWorkerCallback),
          (error: unknown) =>
            port1.postMessage({
              kind: "published",
              id: message.id,
              error: String(error),
            } satisfies GenerationWorkerCallback),
        );
      return;
    }
    if (message.kind !== "mapping") {
      return;
    }
    let filename: string | undefined;
    let error: string | undefined;
    try {
      filename = moduleSource?.(message.filename) ?? message.filename;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    port1.postMessage({
      kind: "mapped",
      id: message.id,
      filename,
      error,
    } satisfies GenerationWorkerCallback);
    Atomics.store(message.signal, 0, 1);
    Atomics.notify(message.signal, 0);
  }
  port1.on("message", callback);
  port1.unref();
  const close = () =>
    (closing ??= (async () => {
      stopObserving();
      try {
        if (pending) {
          await (drained ??= createDeferredCore()).promise;
        }
        // Retained artifacts and recovery leases belong to the worker; dispose
        // them before the pool joins its physical execution lifetime.
        await pool.closeResources();
        await pool.close();
        await releaseRoot();
        owner.clients.delete(close);
      } finally {
        port1.close();
      }
    })());
  owner.clients.add(close);
  const codec = new GenerationCodec(
    (handle, args, asynchronous, sourceCapture, disposal) => {
      // Terminal cleanup already owns remote disposal; callers join its outcome.
      if (closing && disposal) {
        return asynchronous ? closing : undefined;
      }
      const command: GenerationWorkerInput = {
        operation: "call",
        handle,
        asynchronous,
        args: codec.encodeArguments(args),
      };
      return asynchronous ? request(command) : requestSync(command, sourceCapture);
    },
    () => {
      throw new Error("Host-owned native leases must return to their original owner");
    },
  );
  function accept(reply: GenerationWorkerReply): unknown {
    resources = reply.resources;
    codec.releaseReceivedHandles(reply.released ?? []);
    if ("error" in reply) {
      // Reload recovery distinguishes unavailable old source from fatal preparation errors.
      const error =
        reply.error.name === "PluginSourceRecoveryUnavailableError"
          ? new PluginSourceRecoveryUnavailableError(undefined)
          : new Error(reply.error.message);
      throw Object.assign(error, reply.error);
    }
    if (reply.admission) {
      adoptPluginNativeAdmissions(
        admission,
        // SAFETY: The matching worker encodes only PluginNativeAdmissionTransfer in this field.
        codec.decode(reply.admission) as PluginNativeAdmissionTransfer,
      );
    }
    return codec.decode(reply.value);
  }
  async function request(command: GenerationWorkerInput): Promise<unknown> {
    if (closing) {
      throw new Error("Plugin preparation worker has closed");
    }
    pending++;
    let task: ReturnType<typeof pool.startTask> | undefined;
    try {
      task = pool.startTask(
        { ...command, nativeLoads: [...pendingNativeLoads] },
        {
          // Capture cost scales with package size and filesystem latency. Its owner
          // controls retirement; an arbitrary deadline can reject healthy plugins.
          ...(command.operation === "capture" ? {} : { timeoutMs: 120_000 }),
          transferList: (value) =>
            value.operation === "capture" && value.callbackPort ? [value.callbackPort] : [],
        },
      );
      pendingNativeLoads.clear();
      return accept(await task.result);
    } finally {
      try {
        if (task) {
          await task.release().result;
        }
      } finally {
        pending--;
        if (!pending) {
          drained?.resolve();
        }
        if (!pending && !resources) {
          await close();
        }
      }
    }
  }
  function requestSync(command: GenerationWorkerInput, sourceCapture: boolean): unknown {
    if (closing) {
      throw new Error("Plugin preparation worker has closed");
    }
    pending++;
    let task: ReturnType<typeof pool.startTask> | undefined;
    const join = <T>(operation: {
      service(): void;
      read():
        | { status: "pending" }
        | { status: "fulfilled"; value: T }
        | { status: "rejected"; error: unknown };
    }): T => {
      for (;;) {
        operation.service();
        // SAFETY: This private port receives only the matching worker callback protocol.
        const message = receiveMessageOnPort(port1)?.message as
          | GenerationWorkerCallback
          | undefined;
        if (message) {
          callback(message);
        }
        const outcome = operation.read();
        if (outcome.status === "fulfilled") {
          return outcome.value;
        }
        if (outcome.status === "rejected") {
          throw outcome.error;
        }
        Atomics.wait(waitSignal, 0, 0, 2);
      }
    };
    try {
      task = pool.startTask(
        { ...command, nativeLoads: [...pendingNativeLoads] },
        // Recovery and custody copies have the same owner-controlled lifetime as
        // initial capture. Keep ordinary synchronous methods bounded.
        sourceCapture ? {} : { timeoutMs: 30_000 },
      );
      pendingNativeLoads.clear();
      return accept(join(task));
    } finally {
      try {
        if (task) {
          join(task.release());
        }
      } finally {
        pending--;
        if (!pending) {
          drained?.resolve();
        }
        if (!pending && !resources) {
          queueMicrotask(() => {
            void close();
          });
        }
      }
    }
  }
  try {
    const artifact = await request({
      operation: "capture",
      captureId: 1,
      rootDir: params.rootDir,
      entryFile: params.standalone ? params.source : undefined,
      storage,
      installRoots,
      readOnly,
      scratch: root.directory,
      managedRoot: root.managedRoot,
      callbackPort: port2,
      admission: {
        // One artifact uses one owner; shared native indexes still serve dependencies outside it.
        owners: new Map(admissionOwner ? [[admissionRoot, admissionOwner]] : []),
        managedRoots: admission.managedRoots,
        receipts: new Map(
          [...admission.receipts].filter(([key]) => key.startsWith(`${admissionRoot}\0`)),
        ),
        files: admission.files,
        namespaces: admission.namespaces,
      },
    });
    return {
      // SAFETY: A successful capture reply encodes the worker's PluginGenerationArtifact.
      artifact: artifact as PluginGenerationArtifact,
      attachModuleSource: (mapper) => {
        moduleSource = mapper;
      },
    };
  } catch (error) {
    if (!resources) {
      await close();
    }
    throw error;
  }
}
