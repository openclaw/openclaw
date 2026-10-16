import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
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
/** Each exposed artifact owns its capture worker; registry instance caching owns reuse. */
export async function preparePluginGenerationArtifact(
  params: PreparationParameters,
): Promise<PreparedPluginGenerationArtifact> {
  return createPreparationClient().prepare(params);
}
/** One artifact lifetime owns its worker, including recovery and native-root leases. */
function createPreparationClient() {
  const storage = resolvePluginSourceCaptureStorage();
  const installRoots = resolveActivePluginInstallRoots();
  const publishAdmission = createPluginSourceAdmissionPublisher({
    stateDir: installRoots.stateDir,
  });
  const readOnly = isArtifactPreservingStateRead();
  const admission = nativeAdmissionStateFor();
  const root = createPluginSourceCaptureRoot(storage.stateDir, "plugin-preparation-");
  let releasedRoot: Promise<void> | undefined;
  const releaseRoot = () => (releasedRoot ??= root.release());
  const { port1, port2 } = new MessageChannel();
  const moduleSources = new Map<number, (filename: string) => string>();
  let nextCapture = 0;
  let resources = 0;
  let pending = 0;
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
    { retainedTransport: true },
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
      filename = moduleSources.get(message.captureId)?.(message.filename) ?? message.filename;
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
        await pool.close();
        await releaseRoot();
      } finally {
        port1.close();
      }
    })());
  const codec = new GenerationCodec(
    (handle, args, asynchronous, sourceCapture) => {
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
        if (!pending && !resources) {
          queueMicrotask(() => {
            void close();
          });
        }
      }
    }
  }
  let initialized = false;
  return {
    get closed() {
      return Boolean(closing);
    },
    async prepare(params: PreparationParameters): Promise<PreparedPluginGenerationArtifact> {
      const captureId = ++nextCapture;
      const callbackPort = initialized ? undefined : port2;
      initialized = true;
      try {
        const artifact = await request({
          operation: "capture",
          captureId,
          rootDir: params.rootDir,
          entryFile: params.standalone ? params.source : undefined,
          storage,
          installRoots,
          readOnly,
          scratch: root.directory,
          managedRoot: root.managedRoot,
          callbackPort,
          admission: {
            owners: admission.owners,
            managedRoots: admission.managedRoots,
            receipts: admission.receipts,
            files: admission.files,
            namespaces: admission.namespaces,
          },
        });
        return {
          // SAFETY: A successful capture reply encodes the worker's PluginGenerationArtifact.
          artifact: artifact as PluginGenerationArtifact,
          attachModuleSource: (mapper) => {
            moduleSources.set(captureId, mapper);
          },
        };
      } catch (error) {
        if (!resources) {
          await close();
        }
        throw error;
      }
    },
  };
}
