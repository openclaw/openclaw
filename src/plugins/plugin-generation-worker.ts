import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { resolveActivePluginInstallRoots } from "./install-root-context.js";
import {
  bundledPluginCaptureInputs,
  resolveBundledPluginReloadSource,
} from "./plugin-bundled-reload.js";
import { getPluginCache } from "./plugin-cache.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginGenerationArtifactSteps } from "./plugin-generation-capture.js";
import { createPluginFrozenGenerationSteps } from "./plugin-generation-frozen-source.js";
import {
  addPluginGenerationMetrics,
  getPluginGenerationMetrics,
  type PluginGenerationMetrics,
} from "./plugin-generation-metrics.js";
import { createPluginGenerationNativeRoots } from "./plugin-generation-native-roots.js";
import {
  createPreparationPool,
  preparationOwnerFor,
} from "./plugin-generation-preparation-pool.js";
import type {
  inspectPluginGenerationSources,
  inspectPluginSourceDependencies,
} from "./plugin-generation-source-inspection.js";
import {
  retainPreparedPluginGenerationSource,
  type PluginSourceCustodyFork,
} from "./plugin-generation-source-lookup.js";
import { GenerationCodec } from "./plugin-generation-worker-codec.js";
import type {
  GenerationWorkerInput,
  GenerationWorkerReply,
  GenerationWorkerCallback,
} from "./plugin-generation-worker-contract.js";
import {
  markPluginSourceAcquisitionError,
  PluginDependencyLinkError,
  PluginSourceRecoveryUnavailableError,
} from "./plugin-instance-error.js";
import {
  adoptPluginNativeAdmissions,
  nativeAdmissionStateFor,
  settlePluginNativeAdmissionState,
  type PluginNativeAdmissionTransfer,
} from "./plugin-native-admission-state.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-context.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import { resolvePluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { subscribePluginNativeLoads } from "./plugin-source-capture-native-loads.js";
import { createPluginSourceCaptureState } from "./plugin-source-capture-state.js";
import { preparePluginSourceSnapshotAdmission } from "./plugin-source-snapshot-artifact.js";
import { PluginSourceSnapshotValidationError } from "./plugin-source-snapshot-payload.js";
import type {
  PluginSourceSnapshotBinding,
  PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";

export type PreparedPluginGenerationArtifact = {
  artifact: PluginGenerationArtifact;
  attachModuleSource(callback: (filename: string) => string): void;
};
type PreparationParameters = {
  rootDir: string;
  source: string | readonly string[];
  standalone?: boolean;
  bundledReload?: boolean;
  sourceSnapshot?: { descriptor: PluginSourceSnapshotDescriptor; stateDir: string };
};
export type PreparedPluginSourceSnapshot = {
  contentDigest: string;
  dependencyClosureDigest: string;
  publish(
    binding: PluginSourceSnapshotBinding,
  ): Promise<Omit<PluginSourceSnapshotDescriptor, "installedRevision">>;
  dispose(): void;
  disposeAsync(): Promise<void>;
};
type CaptureCommand = Extract<GenerationWorkerInput, { operation: "capture" }>;
type OwnedPreparationParameters = PreparationParameters &
  Pick<
    CaptureCommand,
    | "retainSourceCustody"
    | "sourceCustodyId"
    | "sourceCustodyDigest"
    | "inspection"
    | "snapshotPublication"
  >;
/** Artifacts keep separate capture custody and share their owner's preparation isolate. */
export async function preparePluginGenerationArtifact(
  params: PreparationParameters,
): Promise<PreparedPluginGenerationArtifact> {
  const owner = preparationOwnerFor(
    captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }),
  );
  const admission = nativeAdmissionStateFor();
  const rootDir = path.resolve(params.rootDir);
  // Published snapshots already own immutable bytes; rebuild their runtime owner independently.
  const source = params.sourceSnapshot
    ? undefined
    : await retainPreparedPluginGenerationSource(
        owner,
        JSON.stringify([
          rootDir,
          params.standalone ? params.source : undefined,
          params.bundledReload,
          admission.viewKey,
          admission.owners.get(rootDir),
        ]),
        async () => {
          const seed = await prepareOwnedPluginGeneration({
            ...params,
            retainSourceCustody: true,
          });
          // SAFETY: A seed capture returns only its retained source digest.
          const { sourceDigest } = seed.value as { sourceDigest: string };
          return { captureId: seed.captureId, sourceDigest, disposeAsync: seed.close };
        },
      );
  const prepared = await prepareOwnedPluginGeneration({
    ...params,
    sourceCustodyId: source?.captureId,
    sourceCustodyDigest: source?.sourceDigest,
  });
  // The worker transfers retained bytes, not an executable graph of RPC methods.
  // Resolution, lazy acquisition and host aliases all stay in the consuming isolate.
  // SAFETY: The artifact preparation command returns its retained source custody fork.
  const retained = prepared.value as PluginSourceCustodyFork;
  prepared.retainNative(retained.source.native);
  const sourceCapture = createPluginSourceCaptureState({
    directory: retained.source.sourceCapture.directory,
    outputRoot: retained.source.sourceCapture.outputRoot,
    assertAvailable: prepared.assertAvailable,
    dispose: retained.source.dispose,
    disposeAsync: retained.source.disposeAsync,
  });
  const custody: PluginSourceCustodyFork = {
    ...retained,
    source: {
      ...retained.source,
      sourceCapture,
      dispose: sourceCapture.dispose,
      disposeAsync: sourceCapture.disposeAsync,
    },
  };
  const { captureRoot, entryFile, bundledReloadSource } = prepared.captureInput;
  let moduleSource: ((filename: string) => string) | undefined;
  const create = (resolveInput?: (filename: string) => string) =>
    createPluginGenerationArtifactSteps(
      custody.source.frozenSource?.rootDir ?? captureRoot,
      custody.source.frozenSource ? undefined : entryFile,
      (run) => run(),
      (filename) => moduleSource?.(filename) ?? filename,
      undefined,
      undefined,
      bundledReloadSource,
      custody,
      true,
      false,
      resolveInput,
      "caller",
    );
  // This async owner joins failed reconstruction cleanup below; generators must
  // not synchronously dispose retained custody through the worker transport.
  const steps = custody.source.frozenSource
    ? createPluginFrozenGenerationSteps(custody.source.frozenSource, create, "caller")
    : create();
  const publisher =
    admission.owners.has(path.resolve(captureRoot)) && !admission.artifactPreservingReadOnly
      ? createPluginSourceAdmissionPublisher({ stateDir: admission.publicationStateDir })
      : undefined;
  const advance = () => withPluginSourceAdmissionPublisher(publisher, () => steps.next());
  try {
    custody.source.native?.retain(getPluginCache());
    let step = advance();
    while (!step.done) {
      await nextTurn();
      prepared.assertAvailable();
      step = advance();
    }
    await settlePluginNativeAdmissionState(admission);
    return {
      artifact: step.value,
      attachModuleSource: (mapper) => {
        moduleSource = mapper;
      },
    };
  } catch (error) {
    await custody.source.disposeAsync();
    throw error;
  }
}

/** Capture unexecuted installation source; publication authority remains with the caller. */
export async function preparePluginSourceSnapshot(params: {
  rootDir: string;
  stateDir: string;
}): Promise<PreparedPluginSourceSnapshot> {
  const prepared = await prepareOwnedPluginGeneration({
    rootDir: params.rootDir,
    source: params.rootDir,
    snapshotPublication: {
      stateDir: params.stateDir,
    },
  });
  const { bindPluginSnapshotPublication } = await import("./plugin-source-snapshot-publication.js");
  return bindPluginSnapshotPublication(
    // SAFETY: The source-only command returns the worker's owned staging handle.
    prepared.value as Parameters<typeof bindPluginSnapshotPublication>[0],
    params.stateDir,
  );
}

/** Inspect exact captured inputs without blocking the host or evaluating plugin code. */
export async function inspectPluginSourceDependenciesAsync(
  entries: Parameters<typeof inspectPluginSourceDependencies>[0],
  boundary?: Parameters<typeof inspectPluginSourceDependencies>[1],
): Promise<ReturnType<typeof inspectPluginSourceDependencies>> {
  const first = entries[0];
  if (!first) {
    return { files: [], packageRoots: [], unresolved: [], references: [] };
  }
  const prepared = await prepareOwnedPluginGeneration({
    rootDir: first.rootDir,
    source: first.entryFile,
    inspection: { kind: "dependencies", entries, dependencyRoot: boundary?.root },
  });
  // SAFETY: The internal dependency command returns plain facts and ordered warning arguments.
  const result = prepared.value as {
    inspection: ReturnType<typeof inspectPluginSourceDependencies>;
    unresolvedAncestors: Array<{ name: string; importer: string }>;
  };
  for (const { name, importer } of result.unresolvedAncestors) {
    boundary?.onUnresolvable(name, importer);
  }
  return result.inspection;
}

export async function inspectPluginGenerationSourcesAsync(
  entries: Parameters<typeof inspectPluginGenerationSources>[0],
): Promise<ReturnType<typeof inspectPluginGenerationSources>> {
  const first = entries[0];
  if (!first) {
    return { sourceDigests: {} };
  }
  const prepared = await prepareOwnedPluginGeneration({
    rootDir: first.rootDir,
    source: first.entryFile ?? first.rootDir,
    inspection: { kind: "sources", entries },
  });
  // SAFETY: The internal source command returns only its inspected digest projection.
  return (prepared.value as { inspection: ReturnType<typeof inspectPluginGenerationSources> })
    .inspection;
}

async function prepareOwnedPluginGeneration(params: OwnedPreparationParameters) {
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
  const admissionRoots = new Set(
    (params.inspection?.entries ?? [params]).map(({ rootDir }) => path.resolve(rootDir)),
  );
  const admissionPrefixes = [...admissionRoots].map((rootDir) => `${rootDir}\0`);

  let releasedRoot: Promise<void> | undefined;
  let transferredNative: PluginSourceCustodyFork["source"]["native"];
  const releaseRoot = () =>
    (releasedRoot ??= Promise.all([
      transferredNative?.disposeAsync(),
      nativeRoots.close(),
      shared.captures.releaseSource(captureId),
    ]).then(() => {}));
  const { port1, port2 } = new MessageChannel();
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
    if (message.kind !== "native-root-reference") {
      return;
    }
    const reply: Extract<GenerationWorkerCallback, { kind: "callback-result" }> = {
      kind: "callback-result",
      id: message.id,
    };
    try {
      if (message.kind === "native-root-reference") {
        let retainedRoot: ReturnType<typeof nativeRoots.retainByDirectory>;
        for (const client of shared.clients.values()) {
          retainedRoot = client.retainNativeRoot(message.directory);
          if (retainedRoot) {
            break;
          }
        }
        if (!retainedRoot) {
          throw new Error("Plugin native source custody is unavailable");
        }
        reply.root = nativeRoots.adopt(retainedRoot);
      }
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
    retainNativeRoot: (directory) => nativeRoots.retainByDirectory(directory),
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
      return asynchronous ? request(command, sourceCapture) : requestSync(command, sourceCapture);
    },
    {
      exportRoot: () => {
        throw new Error("Host-owned native leases cannot enter plugin preparation");
      },
      importRoot: (id) => nativeRoots.retain(id),
    },
  );
  function accept(
    reply: GenerationWorkerReply,
    metrics: PluginGenerationMetrics | undefined,
  ): unknown {
    if (reply.metrics) {
      addPluginGenerationMetrics(metrics, reply.metrics);
    }
    resources = reply.resources;
    codec.releaseReceivedHandles(reply.released ?? []);
    if ("error" in reply) {
      // Reload recovery distinguishes unavailable old source from fatal preparation errors.
      const error =
        reply.error.name === "PluginSourceRecoveryUnavailableError"
          ? new PluginSourceRecoveryUnavailableError(undefined)
          : reply.error.name === "PluginDependencyLinkError"
            ? new PluginDependencyLinkError(reply.error.message)
            : reply.error.name === "PluginSourceSnapshotValidationError" &&
                reply.error.artifactPath !== undefined
              ? new PluginSourceSnapshotValidationError(
                  reply.error.artifactPath,
                  reply.error.message,
                )
              : reply.error.name === "PluginSnapshotDependencyError" &&
                  reply.error.modulePath !== undefined
                ? new PluginSnapshotDependencyError(reply.error.modulePath)
                : reply.error.name === "SyntaxError"
                  ? new SyntaxError(reply.error.message)
                  : new Error(reply.error.message);
      Object.assign(error, reply.error);
      throw reply.sourceAcquisitionFailure ? markPluginSourceAcquisitionError(error) : error;
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
  /**
   * Captures used to run unbounded: a wedged preparation worker (native-load child,
   * staging copy) idled Doctor's Config-repairs phase forever at zero CPU
   * (openclaw#178359). Keep the budget generous — package size and filesystem
   * latency scale it — but finite, with an operator override for slow hosts.
   */
  function resolvePluginCaptureTimeoutMs(): number {
    const raw = Number(process.env.OPENCLAW_PLUGIN_CAPTURE_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) {
      return Math.min(Math.max(raw, 1_000), 60 * 60_000);
    }
    return 15 * 60_000;
  }
  function captureTimeoutError(error: unknown, captureTimeoutMs: number): Error {
    return new Error(
      `Plugin capture did not complete within ${(captureTimeoutMs / 1000).toFixed(1)}s ` +
        `(capture ${captureId}, root ${params.rootDir}); the preparation worker stayed silent. ` +
        "Raise OPENCLAW_PLUGIN_CAPTURE_TIMEOUT_MS for slower hosts, then retry.",
      { cause: error },
    );
  }
  async function request(command: GenerationWorkerInput, sourceCapture = false): Promise<unknown> {
    if (closing) {
      throw new Error("Plugin preparation worker has closed");
    }
    const metrics = getPluginGenerationMetrics();
    const started = performance.now();
    pending++;
    let task: ReturnType<typeof pool.startTask> | undefined;
    try {
      if (command.operation === "capture" && command.sourceSnapshot) {
        await preparePluginSourceSnapshotAdmission({
          ...command.sourceSnapshot,
          assertCurrent: () => {
            if (closing || owner.closing) {
              throw new Error("Plugin preparation worker has closed");
            }
          },
        });
      }
      const captureTimeoutMs =
        command.operation === "capture" || sourceCapture
          ? resolvePluginCaptureTimeoutMs()
          : 120_000;
      task = shared.startTask(
        { ...command, nativeLoads: [...pendingNativeLoads] },
        {
          // Capture cost scales with package size and filesystem latency. Its owner
          // controls retirement; the budget stays generous but no longer unbounded.
          timeoutMs: captureTimeoutMs,
          progressSignal: waitSignal,
          transferList: (value) =>
            value.operation === "capture" && value.callbackPort ? [value.callbackPort] : [],
        },
      );
      pendingNativeLoads.clear();
      let reply: GenerationWorkerReply;
      try {
        reply = await task.result;
      } catch (error) {
        if (error instanceof WorkerTaskError && error.code === "timeout") {
          throw captureTimeoutError(error, captureTimeoutMs);
        }
        throw error;
      }
      const value = accept(reply, metrics);
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
        if (metrics) {
          metrics.hostMs += performance.now() - started;
        }
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
    const metrics = getPluginGenerationMetrics();
    const started = performance.now();
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
      // Recovery and custody copies share the capture budget; ordinary synchronous
      // methods stay bounded well below it.
      const captureTimeoutMs = sourceCapture ? resolvePluginCaptureTimeoutMs() : 30_000;
      task = shared.startTask(
        { ...command, nativeLoads: [...pendingNativeLoads] },
        { progressSignal: waitSignal, timeoutMs: captureTimeoutMs },
      );
      pendingNativeLoads.clear();
      let reply: GenerationWorkerReply;
      try {
        reply = join(task);
      } catch (error) {
        if (error instanceof WorkerTaskError && error.code === "timeout") {
          throw captureTimeoutError(error, captureTimeoutMs);
        }
        throw error;
      }
      return accept(reply, metrics);
    } finally {
      try {
        if (task) {
          join(shared.release(task));
        }
      } finally {
        if (metrics) {
          metrics.hostMs += performance.now() - started;
        }
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
    const bundledReloadSource = params.bundledReload
      ? resolveBundledPluginReloadSource(params.rootDir)
      : undefined;
    const [captureRoot, entries] = bundledPluginCaptureInputs({
      ...params,
      source: typeof params.source === "string" ? params.source : params.rootDir,
      bundledReloadSource,
    });
    const entryFile = params.standalone && !bundledReloadSource ? params.source : entries;
    const artifact = await request({
      operation: "capture",
      captureId,
      progressSignal: waitSignal,
      rootDir: captureRoot,
      entryFile,
      bundledReloadSource,
      storage,
      installRoots,
      readOnly,
      retainSourceCustody: params.retainSourceCustody,
      sourceCustodyId: params.sourceCustodyId,
      sourceCustodyDigest: params.sourceCustodyDigest,
      inspection: params.inspection,
      sourceSnapshot: params.sourceSnapshot,
      snapshotPublication: params.snapshotPublication,
      callbackPort: port2,
      admission: {
        // Each selected package keeps its own admission authority; dependencies share indexes.
        owners: new Map([...admission.owners].filter(([rootDir]) => admissionRoots.has(rootDir))),
        managedRoots: admission.managedRoots,
        receipts: new Map(
          [...admission.receipts].filter(([key]) =>
            admissionPrefixes.some((prefix) => key.startsWith(prefix)),
          ),
        ),
        files: admission.files,
        namespaces: admission.namespaces,
      },
    });
    return {
      value: artifact,
      captureInput: { captureRoot, entryFile, bundledReloadSource },
      captureId,
      close,
      retainNative: (native: PluginSourceCustodyFork["source"]["native"]) => {
        // A decoded native lease also belongs to this session on unexpected exit.
        transferredNative = native;
      },
      assertAvailable: () => {
        if (closing || owner.closing || shared.retired) {
          throw new Error("Plugin preparation worker has closed");
        }
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Plugin preparation and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
