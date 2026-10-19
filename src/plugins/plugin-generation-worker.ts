import path from "node:path";
import { MessageChannel } from "node:worker_threads";
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
import { createPluginCaptureResolver } from "./plugin-capture-resolution.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  createPluginGenerationArtifact,
  type PluginGenerationPreparationOwner,
} from "./plugin-generation-capture.js";
import { createPluginGenerationNativeRoots } from "./plugin-generation-native-roots.js";
import type {
  GenerationWorkerInput,
  GenerationWorkerReply,
  GenerationWorkerCallback,
} from "./plugin-generation-worker-contract.js";
import {
  adoptPluginNativeAdmissions,
  nativeAdmissionStateFor,
  retainPluginNativeAdmissionState,
  settlePluginNativeAdmissionState,
} from "./plugin-native-admission-state.js";
import { createPluginSourceCapture } from "./plugin-package-metadata-capture.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-context.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import { resolvePluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

export type PreparedPluginGenerationArtifact = {
  artifact: PluginGenerationArtifact;
  attachModuleSource(
    callback: (filename: string) => string,
    execute?: <T>(run: () => T) => T,
  ): void;
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

// Keep the live artifact's closure outside the worker client's activation. It owns
// only source state, resolution policy, and its eventual instance execution scope.
function restorePreparedArtifact(
  rootDir: string,
  entryFile: string | undefined,
  owner: PluginGenerationPreparationOwner,
): PreparedPluginGenerationArtifact {
  let moduleSource = (filename: string) => filename;
  let execute = <T>(run: () => T): T => run();
  const artifact = createPluginGenerationArtifact(
    rootDir,
    entryFile,
    (run) => execute(run),
    (filename) => moduleSource(filename),
    undefined,
    undefined,
    undefined,
    false,
    owner,
  );
  return {
    artifact,
    attachModuleSource(callback, scope) {
      moduleSource = callback;
      if (scope) {
        execute = scope;
      }
    },
  };
}

/** Preparation borrows host custody; the returned artifact has no live worker references. */
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
  const nativeRoots = createPluginGenerationNativeRoots(storage);
  const sourceCapture = createPluginSourceCapture();
  const admissionCustody = retainPluginNativeAdmissionState(admission);
  const resolution = createPluginCaptureResolver();
  const { port1, port2 } = new MessageChannel();
  let exited = false;
  let failed = false;
  let handedOff = false;
  const finished = createDeferredCore();
  let disposed: Promise<void> | undefined;
  const disposeSource = () =>
    (disposed ??= (async () => {
      try {
        await sourceCapture.disposeAsync();
      } finally {
        resolution.clear();
        await admissionCustody.disposeAsync();
      }
    })().catch((error: unknown) => {
      disposed = undefined;
      throw error;
    }));
  let pool:
    | ReturnType<typeof createOwnedWorkerTaskPool<GenerationWorkerInput, GenerationWorkerReply>>
    | undefined;
  const close = async () => {
    await pool?.close();
    await finished.promise;
    await nativeRoots.close();
    if (!handedOff) {
      await disposeSource();
    }
    owner.clients.delete(close);
  };
  // Failed physical stops must remain reachable by terminal cleanup; completed
  // preparations leave this set and never retain the live artifact's source graph.
  owner.clients.add(close);
  try {
    pool = createOwnedWorkerTaskPool<GenerationWorkerInput, GenerationWorkerReply>(
      {
        workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.pluginGenerationPreparation),
        maxWorkers: 1,
        idleTimeoutMs: 0,
        restartOnError: false,
        prepareWorker: () => ({
          options: {},
          async releaseResources() {
            // Native custody calls this only after confirmed physical exit, including retries.
            exited = true;
            port1.close();
            if (failed) {
              try {
                await nativeRoots.close();
              } finally {
                await disposeSource();
              }
            }
          },
        }),
      },
      { retainedTransport: true, nativeSource },
    );
    port1.on("message", (message: GenerationWorkerCallback) => {
      if (message.kind === "callback-result") {
        return;
      }
      const reply: Extract<GenerationWorkerCallback, { kind: "callback-result" }> = {
        kind: "callback-result",
        id: message.id,
      };
      try {
        if (message.kind === "native-root") {
          reply.root = nativeRoots.allocate();
        } else if (message.kind === "resolve") {
          reply.resolved = resolution.resolve(
            message.source,
            message.reference,
            message.conditions,
          );
        } else {
          const { transform: _transform, ...options } = resolution.get(message.source).options;
          reply.options = options;
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        reply.error = { message: failure.message, name: failure.name, stack: failure.stack };
      }
      port1.postMessage(reply);
      Atomics.store(message.signal, 0, 1);
      Atomics.notify(message.signal, 0);
    });
    port1.unref();
    const admissionRoot = path.resolve(params.rootDir);
    const admissionOwner = admission.owners.get(admissionRoot);
    const entryFile = params.standalone ? params.source : undefined;
    const task = pool.startTask(
      {
        operation: "capture",
        rootDir: params.rootDir,
        entryFile,
        storage,
        installRoots,
        readOnly,
        sourceCapture: { directory: sourceCapture.directory, outputRoot: sourceCapture.outputRoot },
        callbackPort: port2,
        admission: {
          owners: new Map(admissionOwner ? [[admissionRoot, admissionOwner]] : []),
          managedRoots: admission.managedRoots,
          receipts: new Map(
            [...admission.receipts].filter(([key]) => key.startsWith(`${admissionRoot}\0`)),
          ),
          files: admission.files,
          namespaces: admission.namespaces,
        },
      },
      { transferList: (value) => [value.callbackPort] },
    );
    const reply = await task.result;
    if ("error" in reply) {
      throw Object.assign(new Error(reply.error.message), reply.error);
    }
    adoptPluginNativeAdmissions(
      admission,
      {
        ...reply.admission,
        roots: reply.admission.roots.map((id) => nativeRoots.retain(id)),
      },
      publishAdmission,
    );
    await settlePluginNativeAdmissionState(admission);
    // Host admission owns native durability before preparation custody is released.
    await task.release({ retire: true }).result;
    await nativeRoots.close();
    await pool.close();
    const prepared = withPluginSourceAdmissionPublisher(publishAdmission, () =>
      restorePreparedArtifact(params.rootDir, entryFile, {
        admission,
        sourceCapture,
        resolution,
        state: reply.state,
      }),
    );
    await admissionCustody.disposeAsync();
    handedOff = true;
    owner.clients.delete(close);
    return prepared;
  } catch (error) {
    failed = true;
    const failures: unknown[] = [error];
    try {
      await pool?.close();
      exited = true;
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (exited) {
      port1.close();
      port2.close();
      for (const release of [() => nativeRoots.close(), disposeSource]) {
        try {
          await release();
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Plugin preparation and cleanup failed", { cause: error });
    }
    owner.clients.delete(close);
    throw error;
  } finally {
    finished.resolve();
  }
}
