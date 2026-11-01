import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { throwSettledAggregate } from "../infra/error-graph-internal.js";
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  capturePluginGenerationArtifactInScope,
  capturePluginSnapshotGeneration,
  capturePluginSourceSnapshot,
} from "./plugin-generation-capture.js";
import {
  createPluginGenerationMetrics,
  withPluginGenerationMetrics,
} from "./plugin-generation-metrics.js";
import {
  markPluginSourceCaptureOperation,
  type PluginRecoverySource,
} from "./plugin-generation-source-lookup.js";
import { GenerationCodec } from "./plugin-generation-worker-codec.js";
import type {
  GenerationWorkerInput,
  GenerationWorkerReply,
  GenerationWorkerCallback,
} from "./plugin-generation-worker-contract.js";
import { isPluginSourceAcquisitionError } from "./plugin-instance-error.js";
import {
  nativeAdmissionStateFor,
  settlePluginNativeAdmissions,
  type PluginNativeAdmissionTransfer,
} from "./plugin-native-admission-state.js";
import { retainPluginNativeRoot } from "./plugin-native-root-lease.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-context.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { recordPluginNativeLoad } from "./plugin-source-capture-native-loads.js";
import {
  acquirePluginSourceSnapshot,
  pluginSourceSnapshotClosureDigest,
  stagePluginSourceSnapshot,
} from "./plugin-source-snapshot-artifact.js";
import type { PluginSourceSnapshotBinding } from "./plugin-source-snapshot.types.js";

type Resource = { dispose(): void; disposeAsync(): Promise<void> };
type CaptureCommand = Extract<GenerationWorkerInput, { operation: "capture" }>;

function createPreparationSession(context: CaptureCommand) {
  const resources = new Set<Resource>();
  const orphaned = new Set<Resource>();
  const owned = new WeakSet<Resource>();
  const sentReceipts: PluginNativeAdmissionTransfer["receipts"] = new Map();
  const sentRoots = new Set<string>();
  const borrowedRootIds = new WeakMap<object, number>();
  const snapshotReaders = new Set<Awaited<ReturnType<typeof acquirePluginSourceSnapshot>>>();

  function admissionChanges() {
    const state = nativeAdmissionStateFor();
    const receipts = new Map(
      [...state.receipts].filter(([key, receipt]) => sentReceipts.get(key) !== receipt),
    );
    const publications = [...state.publications];
    if (!receipts.size && !publications.length) {
      return undefined;
    }
    const directories = new Set(
      [...receipts.values()].flatMap((receipt) => Object.keys(receipt.nativeNamespaces)),
    );
    const roots = [...state.roots]
      .filter((root) => directories.has(root.directory) && !sentRoots.has(root.directory))
      .map((root) => {
        sentRoots.add(root.directory);
        return retainPluginNativeRoot(root);
      });
    for (const [key, receipt] of receipts) {
      sentReceipts.set(key, receipt);
    }
    const encoded = codec.encode({
      receipts,
      roots,
      publications: publications.map(([, publication]) => publication.data),
    } satisfies PluginNativeAdmissionTransfer);
    // Install leases can defer writes beyond source retirement. Hand retry intent
    // to the admission owner with its native custody, never worker callbacks.
    for (const [key, publication] of publications) {
      if (state.publications.get(key) === publication) {
        state.publications.delete(key);
      }
    }
    return encoded;
  }
  function own<T extends Resource>(resource: T): T {
    if (owned.has(resource)) {
      return resource;
    }
    owned.add(resource);
    codec.retainResource(resource);
    resources.add(resource);
    const dispose = resource.dispose.bind(resource);
    const disposeAsync = resource.disposeAsync.bind(resource);
    resource.dispose = () => {
      dispose();
      codec.releaseResource(resource);
      resources.delete(resource);
      orphaned.delete(resource);
    };
    resource.disposeAsync = async () => {
      await disposeAsync();
      codec.releaseResource(resource);
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
  const codec = new GenerationCodec(
    () => {
      throw new Error("Host functions cannot enter plugin preparation");
    },
    {
      exportRoot(root) {
        const id = borrowedRootIds.get(root);
        if (id === undefined) {
          throw new Error("Plugin native root is not owned by the preparation host");
        }
        return id;
      },
      importRoot() {
        throw new Error("Native root leases cannot enter plugin preparation");
      },
    },
  );
  const cache = createPluginCache();
  const callbacks: MessagePort | undefined = context.callbackPort;
  let nextCallback = 0;
  function observe(message: GenerationWorkerCallback): void {
    if (message.kind === "native-load") {
      recordPluginNativeLoad(message.filename);
    }
  }
  function requestHost(
    request: { kind: "mapping"; captureId: number; filename: string } | { kind: "native-root" },
  ): Extract<GenerationWorkerCallback, { kind: "callback-result" }> {
    if (!callbacks) {
      throw new Error("Plugin preparation host is unavailable");
    }
    const id = ++nextCallback;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    callbacks.postMessage(
      {
        ...request,
        id,
        signal,
      } satisfies GenerationWorkerCallback,
      [],
    );
    const progressSignal = context?.progressSignal;
    if (progressSignal) {
      Atomics.add(progressSignal, 0, 1);
      Atomics.notify(progressSignal, 0);
    }
    const deadline = performance.now() + 15_000;
    for (;;) {
      // SAFETY: This private port is transferred only to the matching host callback protocol.
      const message = receiveMessageOnPort(callbacks)?.message as
        | GenerationWorkerCallback
        | undefined;
      if (message?.kind === "callback-result" && message.id === id) {
        if (message.error) {
          throw new Error(message.error);
        }
        return message;
      }
      if (message) {
        observe(message);
      }
      if (performance.now() > deadline) {
        throw new Error("Plugin preparation callback timed out");
      }
      Atomics.wait(signal, 0, 0, 2);
    }
  }
  function mapSource(captureId: number, filename: string): string {
    return callbacks
      ? (requestHost({ kind: "mapping", captureId, filename }).filename ?? filename)
      : filename;
  }
  function createNativeRoot() {
    const reference = requestHost({ kind: "native-root" }).root;
    if (!reference) {
      throw new Error("Plugin preparation host did not allocate native custody");
    }
    const root = {
      directory: reference.directory,
      // The host commits before acknowledging publication and releases custody
      // after capture cleanup or worker exit. This isolate owns neither physical action.
      commit() {},
      dispose() {},
      async disposeAsync() {},
    };
    borrowedRootIds.set(root, reference.id);
    return root;
  }
  function scoped<T>(run: () => T): T {
    const current = context;
    // Each artifact keeps its admission view and recovery custody while sharing execution.
    // Successful replies transfer every write intent to the host. Keeping writes
    // in one admission owner prevents stale worker retries replacing newer receipts.
    return withPluginCache(cache, () =>
      withPluginSourceAdmissionPublisher(
        async () => false,
        () =>
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
    await cache.sourceAdmissions?.dispose();
    throwSettledAggregate(outcomes, "Plugin preparation resources failed to close");
    // The reader outlives independent runtime/native cleanup, including failed disposal.
    for (const snapshot of snapshotReaders) {
      await snapshot.releaseAsync();
    }
    snapshotReaders.clear();
  }
  async function execute(command: GenerationWorkerInput): Promise<GenerationWorkerReply> {
    const metrics = createPluginGenerationMetrics();
    const started = performance.now();
    const reply = await withPluginGenerationMetrics(metrics, () =>
      scoped(async () => {
        for (const filename of command.nativeLoads ?? []) {
          recordPluginNativeLoad(filename);
        }
        let result: unknown;
        let failedCapture: Resource | undefined;
        try {
          if (command.operation === "capture") {
            const state = nativeAdmissionStateFor();
            state.createRoot = createNativeRoot;
            for (const key of [
              "owners",
              "managedRoots",
              "receipts",
              "files",
              "namespaces",
            ] as const) {
              // Import into the owner, then release entries retained by the capture command.
              const target: Map<string, unknown> = state[key];
              command.admission[key].forEach((value, name) => target.set(name, value));
              command.admission[key].clear();
            }
            for (const [key, receipt] of state.receipts) {
              sentReceipts.set(key, receipt);
            }
            if (command.inspection) {
              // Inspection's host capture wrapper must stay outside worker bootstrap.
              const { inspectPluginGenerationSources, inspectPluginSourceDependencies } =
                await import("./plugin-generation-source-inspection.js");
              const inspection = command.inspection;
              const unresolvedAncestors: Array<{ name: string; importer: string }> = [];
              result = {
                inspection:
                  inspection.kind === "sources"
                    ? inspectPluginGenerationSources(inspection.entries)
                    : inspectPluginSourceDependencies(
                        inspection.entries,
                        inspection.dependencyRoot !== undefined
                          ? {
                              root: inspection.dependencyRoot,
                              onUnresolvable: (name, importer) =>
                                unresolvedAncestors.push({ name, importer }),
                            }
                          : undefined,
                      ),
                unresolvedAncestors,
              };
            } else if (command.snapshotPublication) {
              const capture = capturePluginSourceSnapshot(command.rootDir);
              const publication = command.snapshotPublication;
              const snapshot = own({
                contentDigest: capture.sourceDigest,
                dependencyClosureDigest: pluginSourceSnapshotClosureDigest(capture),
                stage: markPluginSourceCaptureOperation(
                  async (binding: PluginSourceSnapshotBinding) =>
                    own(
                      await stagePluginSourceSnapshot({
                        stateDir: publication.stateDir,
                        capture,
                        binding,
                        // The host installation owner checks authority before and after this await.
                        assertCurrent: () => {},
                      }),
                    ),
                ),
                dispose: () => capture.dispose(),
                disposeAsync: () => capture.disposeAsync(),
              });
              failedCapture = snapshot;
              result = snapshot;
            } else {
              const snapshot = command.sourceSnapshot
                ? await acquirePluginSourceSnapshot({
                    ...command.sourceSnapshot,
                    // Index authority belongs to the host; the worker owns artifact validation.
                    assertCurrent: () => {},
                  })
                : undefined;
              if (snapshot) {
                snapshotReaders.add(snapshot);
              }
              const artifact = own(
                snapshot
                  ? capturePluginSnapshotGeneration(
                      snapshot,
                      command.entryFile,
                      (run) => run(),
                      (filename) => mapSource(command.captureId, filename),
                    )
                  : capturePluginGenerationArtifactInScope(
                      command.rootDir,
                      command.entryFile,
                      (run) => run(),
                      (filename) => mapSource(command.captureId, filename),
                    ),
              );
              failedCapture = artifact;
              snapshot?.assertCurrent();
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
              result = artifact;
            }
          } else {
            if (command.asynchronous) {
              await settlePluginNativeAdmissions();
            }
            result = await codec.call(command.handle, command.args);
          }
          if (command.operation !== "call" || command.asynchronous) {
            await settlePluginNativeAdmissions();
          }
          const value =
            command.operation === "call"
              ? codec.encodeResult(result, command.handle)
              : codec.encode(result);
          const admission = admissionChanges();
          return {
            value,
            admission,
            resources: resources.size - orphaned.size,
            released: codec.takeReleasedHandles(),
          };
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
            error: {
              message: exception.message,
              name: exception.name,
              stack: exception.stack,
              ...("code" in exception && typeof exception.code === "string"
                ? { code: exception.code }
                : {}),
              ...("artifactPath" in exception && typeof exception.artifactPath === "string"
                ? { artifactPath: exception.artifactPath }
                : {}),
              ...("modulePath" in exception && typeof exception.modulePath === "string"
                ? { modulePath: exception.modulePath }
                : {}),
            },
            ...((command.operation === "capture" ||
              codec.isSourcePreparationCall(command.handle)) &&
            isPluginSourceAcquisitionError(failure)
              ? { sourceAcquisitionFailure: true as const }
              : {}),
            resources: resources.size - orphaned.size,
            released: codec.takeReleasedHandles(),
          };
        }
      }),
    );
    metrics.workerMs = performance.now() - started;
    return { ...reply, metrics };
  }
  callbacks?.on("message", observe);
  callbacks?.unref();
  return {
    execute,
    async close() {
      await scoped(close);
      callbacks?.close();
    },
  };
}

const sessions = new Map<number, ReturnType<typeof createPreparationSession>>();

async function closeSession(captureId: number): Promise<void> {
  const session = sessions.get(captureId);
  if (session) {
    await session.close();
    sessions.delete(captureId);
  }
}

serveOwnedWorkerTasks<GenerationWorkerReply>(
  async (input) => {
    // SAFETY: The matching internal host submits only GenerationWorkerInput to this pool.
    const command = input as GenerationWorkerInput;
    if (command.operation === "capture") {
      sessions.set(command.captureId, createPreparationSession(command));
    }
    const session = sessions.get(command.captureId);
    if (!session) {
      return {
        error: { name: "Error", message: "Plugin preparation capture has closed" },
        resources: 0,
      };
    }
    return session.execute(command);
  },
  {
    async closeResource(key) {
      if (key !== undefined) {
        await closeSession(Number(key));
        return;
      }
      const outcomes = await Promise.allSettled([...sessions.keys()].map(closeSession));
      throwSettledAggregate(outcomes, "Plugin preparation resources failed to close");
    },
    retireOnError: false,
  },
);
