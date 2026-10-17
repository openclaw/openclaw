import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { getPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  createPluginGenerationSourceCustody,
  markPluginSourceCaptureOperation,
  type PluginRecoverySource,
} from "./plugin-generation-source-lookup.js";
import { GenerationCodec } from "./plugin-generation-worker-codec.js";
import type {
  GenerationWorkerInput,
  GenerationWorkerReply,
  GenerationWorkerCallback,
} from "./plugin-generation-worker-contract.js";
import {
  nativeAdmissionStateFor,
  settlePluginNativeAdmissions,
  type PluginNativeAdmissionTransfer,
} from "./plugin-native-admission-state.js";
import { retainPluginNativeRoot } from "./plugin-native-root-lease.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { recordPluginNativeLoad } from "./plugin-source-capture-native-loads.js";

type Resource = { dispose(): void; disposeAsync(): Promise<void> };
const resources = new Set<Resource>();
const orphaned = new Set<Resource>();
const owned = new WeakSet<Resource>();
const sourceCustody = createPluginGenerationSourceCustody();
const sentReceipts: PluginNativeAdmissionTransfer["receipts"] = new Map();
const sentRoots = new Set<string>();

function admissionChanges() {
  const state = nativeAdmissionStateFor();
  const receipts = new Map(
    [...state.receipts].filter(([key, receipt]) => sentReceipts.get(key) !== receipt),
  );
  if (!receipts.size) {
    return undefined;
  }
  const directories = new Set(
    [...receipts.values()].flatMap((receipt) => Object.keys(receipt.nativeNamespaces)),
  );
  const roots = [...state.roots]
    .filter((root) => directories.has(root.directory) && !sentRoots.has(root.directory))
    .map((root) => {
      sentRoots.add(root.directory);
      return own(retainPluginNativeRoot(root));
    });
  for (const [key, receipt] of receipts) {
    sentReceipts.set(key, receipt);
  }
  return codec.encode({ receipts, roots } satisfies PluginNativeAdmissionTransfer);
}
function own<T extends Resource>(resource: T): T {
  if (owned.has(resource)) {
    return resource;
  }
  owned.add(resource);
  resources.add(resource);
  const dispose = resource.dispose.bind(resource);
  const disposeAsync = resource.disposeAsync.bind(resource);
  resource.dispose = () => {
    dispose();
    resources.delete(resource);
    orphaned.delete(resource);
  };
  resource.disposeAsync = async () => {
    await disposeAsync();
    resources.delete(resource);
    orphaned.delete(resource);
  };
  return resource;
}
function ownRecovery(resource: PluginRecoverySource): PluginRecoverySource {
  if (owned.has(resource)) {
    return resource;
  }
  own(resource);
  const fork = resource.fork.bind(resource);
  resource.fork = markPluginSourceCaptureOperation(() => ownRecovery(fork()));
  return resource;
}
const codec = new GenerationCodec(() => {
  throw new Error("Host functions cannot enter plugin preparation");
}, own);
let context: Extract<GenerationWorkerInput, { operation: "capture" }> | undefined;
let callbacks: MessagePort | undefined;
let nextCallback = 0;
const publications = new Map<
  number,
  { resolve(value: boolean): void; reject(error: Error): void }
>();
function publishAdmission(publication: PluginSourceAdmissionPublication): Promise<boolean> {
  if (!callbacks) {
    return Promise.reject(new Error("Plugin admission publisher is unavailable"));
  }
  const id = ++nextCallback;
  return new Promise((resolve, reject) => {
    publications.set(id, { resolve, reject });
    callbacks!.postMessage(
      { kind: "publish", id, publication } satisfies GenerationWorkerCallback,
      [],
    );
  });
}
function observe(message: GenerationWorkerCallback): void {
  if (message.kind === "published") {
    const pending = publications.get(message.id);
    publications.delete(message.id);
    if (message.error) {
      pending?.reject(new Error(message.error));
    } else {
      pending?.resolve(message.accepted === true);
    }
  }
  if (message.kind === "native-load") {
    recordPluginNativeLoad(message.filename);
  }
}
function mapSource(captureId: number, filename: string): string {
  if (!callbacks) {
    return filename;
  }
  const id = ++nextCallback;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  callbacks.postMessage(
    {
      kind: "mapping",
      id,
      captureId,
      filename,
      signal,
    } satisfies GenerationWorkerCallback,
    [],
  );
  const deadline = performance.now() + 15_000;
  for (;;) {
    // SAFETY: This private port is transferred only to the matching host callback protocol.
    const message = receiveMessageOnPort(callbacks)?.message as
      | GenerationWorkerCallback
      | undefined;
    if (message?.kind === "mapped" && message.id === id) {
      if (message.error) {
        throw new Error(message.error);
      }
      return message.filename ?? filename;
    }
    if (message) {
      observe(message);
    }
    if (performance.now() > deadline) {
      throw new Error("Plugin source mapping timed out");
    }
    Atomics.wait(signal, 0, 0, 2);
  }
}
function scoped<T>(run: () => T): T {
  if (!context) {
    throw new Error("Plugin preparation context is not initialized");
  }
  const current = context;
  return sourceCustody.run(() =>
    withPluginSourceAdmissionPublisher(publishAdmission, () =>
      withPluginInstallRoots(current.installRoots, () =>
        withPluginSourceCaptureStorage(current.storage, () =>
          withPluginSourceCaptureDirectory(
            current.scratch,
            () => (current.readOnly ? withArtifactPreservingStateReads(run) : run()),
            current.managedRoot,
          ),
        ),
      ),
    ),
  );
}
async function close(): Promise<void> {
  await settlePluginNativeAdmissions();
  const outcomes = await Promise.allSettled(
    [...resources].map((resource) => resource.disposeAsync()),
  );
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  await sourceCustody.disposeAsync();
  await getPluginCache().sourceAdmissions?.dispose();
  if (errors.length) {
    throw new AggregateError(errors, "Plugin preparation resources failed to close");
  }
}
serveOwnedWorkerTasks<GenerationWorkerReply>(
  async (input) => {
    // SAFETY: The matching internal host submits only GenerationWorkerInput to this pool.
    const command = input as GenerationWorkerInput;
    if (command.operation === "capture") {
      context = command;
      if (command.callbackPort) {
        callbacks = command.callbackPort;
        callbacks.on("message", observe);
        callbacks.unref();
      }
    }
    return scoped(async () => {
      for (const filename of command.nativeLoads ?? []) {
        recordPluginNativeLoad(filename);
      }
      let result: unknown;
      let failedCapture: Resource | undefined;
      try {
        if (command.operation === "capture") {
          const state = nativeAdmissionStateFor();
          for (const key of [
            "owners",
            "managedRoots",
            "receipts",
            "files",
            "namespaces",
          ] as const) {
            // Assign the cloned owner snapshot before acquisition; maps never cross back by reference.
            const target: Map<string, unknown> = state[key];
            for (const [name, value] of command.admission[key]) {
              target.set(name, value);
            }
          }
          for (const [key, receipt] of state.receipts) {
            sentReceipts.set(key, receipt);
          }
          const artifact = own(
            capturePluginGenerationArtifact(
              command.rootDir,
              command.entryFile,
              (run) => run(),
              (filename) => mapSource(command.captureId, filename),
            ),
          );
          const captureRecovery = artifact.captureRecoverySource.bind(artifact);
          artifact.captureRecoverySource = markPluginSourceCaptureOperation(() =>
            ownRecovery(captureRecovery()),
          );
          const retainCustody = artifact.retainSourceCustody.bind(artifact);
          artifact.retainSourceCustody = markPluginSourceCaptureOperation(() => {
            const custody = retainCustody();
            ownRecovery(custody.source);
            return custody;
          });
          failedCapture = artifact;
          result = artifact;
        } else if (command.operation === "call") {
          if (command.asynchronous) {
            await settlePluginNativeAdmissions();
          }
          result = await codec.call(command.handle, command.args);
        } else {
          await close();
        }
        if (command.operation !== "call" || command.asynchronous) {
          await settlePluginNativeAdmissions();
        }
        const value = codec.encode(result);
        const admission = admissionChanges();
        return { value, admission, resources: resources.size - orphaned.size };
      } catch (error) {
        let failure = error;
        if (failedCapture) {
          try {
            await failedCapture.disposeAsync();
          } catch (cleanupError) {
            orphaned.add(failedCapture);
            failure = new AggregateError(
              [error, cleanupError],
              "Plugin capture and cleanup failed",
            );
          }
        }
        const exception = failure instanceof Error ? failure : new Error(String(failure));
        return {
          error: { message: exception.message, name: exception.name, stack: exception.stack },
          resources: resources.size - orphaned.size,
        };
      }
    });
  },
  { closeResource: () => scoped(close), retireOnError: false },
);
