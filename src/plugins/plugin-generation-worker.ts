import path from "node:path";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { resolveActivePluginInstallRoots } from "./install-root-context.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginGenerationNativeRoots } from "./plugin-generation-native-roots.js";
import {
  createPreparationPool,
  preparationOwnerFor,
} from "./plugin-generation-preparation-pool.js";
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
  settlePluginNativeAdmissionState,
  type PluginNativeAdmissionTransfer,
} from "./plugin-native-admission-state.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import { resolvePluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { subscribePluginNativeLoads } from "./plugin-source-capture-native-loads.js";

export type PreparedPluginGenerationArtifact = {
  artifact: PluginGenerationArtifact;
  attachModuleSource(callback: (filename: string) => string): void;
};
type PreparationParameters = {
  rootDir: string;
  source: string | readonly string[];
  standalone?: boolean;
};
/** Artifacts keep separate capture custody and share their owner's preparation isolate. */
export async function preparePluginGenerationArtifact(
  params: PreparationParameters,
): Promise<PreparedPluginGenerationArtifact> {
  const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const owner = preparationOwnerFor(nativeSource);
  const shared =
    owner.pool && !owner.pool.retired
      ? owner.pool
      : await (owner.preparingPool ??= createPreparationPool(nativeSource)
          .then((prepared) => (owner.pool = prepared))
          .finally(() => {
            owner.preparingPool = undefined;
          }));
  if (owner.closing) {
    throw new Error("Plugin preparation owner is closing");
  }
  const { pool } = shared;
  const captureId = ++owner.nextCaptureId;
  const storage = resolvePluginSourceCaptureStorage();
  const installRoots = resolveActivePluginInstallRoots();
  const publishAdmission = createPluginSourceAdmissionPublisher({
    stateDir: installRoots.stateDir,
  });
  const readOnly = isArtifactPreservingStateRead();
  const admission = nativeAdmissionStateFor();
  const nativeRoots = createPluginGenerationNativeRoots();
  const admissionRoot = path.resolve(params.rootDir);
  const admissionOwner = admission.owners.get(admissionRoot);
  let releasedRoot: Promise<void> | undefined;
  const releaseRoot = () =>
    (releasedRoot ??= Promise.all([
      nativeRoots.close(),
      shared.captures.releaseSource(captureId),
    ]).then(() => {}));
  const { port1, port2 } = new MessageChannel();
  let moduleSource: ((filename: string) => string) | undefined;
  let resources = 0;
  let pending = 0;
  let drained: ReturnType<typeof createDeferredCore<void>> | undefined;
  let closing: Promise<void> | undefined;
  const pendingNativeLoads = new Set<string>();
  const waitSignal = new Int32Array(new SharedArrayBuffer(4));
  const stopObserving = subscribePluginNativeLoads((filename) => {
    if (!closing) {
      pendingNativeLoads.add(filename);
    }
  });
  function callback(message: GenerationWorkerCallback): void {
    if (message.kind !== "mapping") {
      return;
    }
    const reply: Extract<GenerationWorkerCallback, { kind: "callback-result" }> = {
      kind: "callback-result",
      id: message.id,
    };
    try {
      reply.filename = moduleSource?.(message.filename) ?? message.filename;
    } catch (failure) {
      reply.error = failure instanceof Error ? failure.message : String(failure);
    }
    port1.postMessage(reply);
    Atomics.store(message.signal, 0, 1);
    Atomics.notify(message.signal, 0);
  }
  port1.on("message", callback);
  port1.unref();
  shared.clients.set(captureId, {
    releaseRoot,
    registerNativeRoot: (root) => nativeRoots.allocate(root),
    service() {
      // SAFETY: This artifact's private port carries only GenerationWorkerCallback messages.
      const message = receiveMessageOnPort(port1)?.message as GenerationWorkerCallback | undefined;
      if (message) {
        callback(message);
      }
    },
  });
  const close = () =>
    (closing ??= (async () => {
      stopObserving();
      try {
        if (pending) {
          await (drained ??= createDeferredCore()).promise;
        }
        // Retained artifacts and recovery leases belong to the worker; dispose
        // them before the pool joins its physical execution lifetime.
        await pool.closeResources(String(captureId));
        // Also release when construction failed before the pool registered custody.
        await releaseRoot();
        shared.clients.delete(captureId);
        if (!shared.clients.size) {
          if (owner.pool === shared) {
            owner.pool = undefined;
          }
          await pool.close();
        }
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
        captureId,
        handle,
        asynchronous,
        args: codec.encodeArguments(args),
      };
      return asynchronous ? request(command) : requestSync(command, sourceCapture);
    },
    {
      exportRoot: () => {
        throw new Error("Host-owned native leases cannot enter plugin preparation");
      },
      importRoot: (id) => nativeRoots.retain(id),
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
        publishAdmission,
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
      task = shared.startTask(
        { ...command, nativeLoads: [...pendingNativeLoads] },
        {
          // Capture cost scales with package size and filesystem latency. Its owner
          // controls retirement; an arbitrary deadline can reject healthy plugins.
          ...(command.operation === "capture" ? {} : { timeoutMs: 120_000 }),
          progressSignal: waitSignal,
          transferList: (value) =>
            value.operation === "capture" && value.callbackPort ? [value.callbackPort] : [],
        },
      );
      pendingNativeLoads.clear();
      const value = accept(await task.result);
      // Async preparation/disposal joins the captured admission owner. Sync lazy
      // imports only queue facts, so they cannot block the host's async writes.
      await settlePluginNativeAdmissionState(admission);
      return value;
    } finally {
      try {
        if (task) {
          await shared.release(task).result;
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
        // A reply arriving during service must invalidate the subsequent wait.
        const observed = Atomics.load(waitSignal, 0);
        operation.service();
        // A sibling capture can precede this synchronous call. Service its callbacks
        // and release completed tasks without waiting for host promise continuations.
        shared.service();
        const outcome = operation.read();
        if (outcome.status === "fulfilled") {
          return outcome.value;
        }
        if (outcome.status === "rejected") {
          throw outcome.error;
        }
        Atomics.wait(waitSignal, 0, observed, 2);
      }
    };
    try {
      task = shared.startTask(
        { ...command, nativeLoads: [...pendingNativeLoads] },
        // Recovery and custody copies have the same owner-controlled lifetime as
        // initial capture. Keep ordinary synchronous methods bounded.
        { progressSignal: waitSignal, ...(sourceCapture ? {} : { timeoutMs: 30_000 }) },
      );
      pendingNativeLoads.clear();
      return accept(join(task));
    } finally {
      try {
        if (task) {
          join(shared.release(task));
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
      captureId,
      progressSignal: waitSignal,
      rootDir: params.rootDir,
      entryFile: params.standalone ? params.source : undefined,
      storage,
      installRoots,
      readOnly,
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
