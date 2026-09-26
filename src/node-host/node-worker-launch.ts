import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type { NativeInferenceStartup } from "../worker/native-inference-startup.js";
import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerCleanupMode } from "./node-worker-launch-receipt.js";
import type {
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchReceipt,
  NodeWorkerLaunchStore,
  NodeWorkerContainerIdentity,
} from "./node-worker-launch-store.js";
import {
  prepareNodeWorkerLaunchTransport,
  startNodeWorkerLaunchTransport,
  type NodeWorkerChildAdapter,
} from "./node-worker-launch-transport.js";
import { nodeWorkerNativeInferenceSecrets } from "./node-worker-native-inference.js";
import {
  createNodeWorkerCredentialScrubber,
  sanitizeNodeWorkerDiagnostic,
} from "./node-worker-output.js";
import {
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import type { NodeWorkerLaunchInput } from "./node-worker-supervisor-contract.js";
import {
  createNodeWorkerActiveTurn,
  nodeWorkerEnvironmentBinding,
  type NodeWorkerActiveOwnership,
  type NodeWorkerRunningChild,
  type NodeWorkerStopState,
} from "./node-worker-supervisor-ownership.js";
import { nodeWorkerDescriptorSecrets } from "./node-worker-turn-lifecycle.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

export const NODE_WORKER_STOP_GRACE_MS = 1_000;

type NodeWorkerLaunchContext = {
  bundleRoot: string;
  workerEnv: NodeJS.ProcessEnv;
  nativeInferenceStartup?: NativeInferenceStartup;
  engineEnv: NodeJS.ProcessEnv;
  store: NodeWorkerLaunchStore;
  turns: NodeWorkerTurnStore;
  capacity: NodeWorkerCapacity;
  containerEngine?: NodeWorkerContainerEngine;
  containerImage?: string;
  containerLifecycle?: NodeWorkerContainerLifecycle;
  active: Map<string, NodeWorkerActiveOwnership>;
  isClosed: () => boolean;
  observeChild: (active: NodeWorkerRunningChild) => Promise<void>;
  stopChild: (active: NodeWorkerRunningChild, state?: NodeWorkerStopState) => Promise<void>;
};

/** Starts one physical owner behind the durable journal gate, independent of turn reuse. */
export async function startNodeWorkerChild(
  context: NodeWorkerLaunchContext,
  params: {
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    claim: NodeWorkerLaunchClaim;
    signal?: AbortSignal;
  },
): Promise<NodeWorkerLaunchReceipt> {
  const sensitiveValues = [
    ...nodeWorkerDescriptorSecrets(params.descriptor),
    ...(params.descriptor.assignment.inference === "runtime-local" && context.nativeInferenceStartup
      ? nodeWorkerNativeInferenceSecrets(context.nativeInferenceStartup)
      : []),
  ];
  const scrubber = createNodeWorkerCredentialScrubber(sensitiveValues);
  // Turn cancellation can beat the child's admission retry deadline. Retain the
  // producer's latest cause so the durable terminal receipt does not become generic.
  const connectionFailure: { errorText?: string } = {};
  for (const value of sensitiveValues) {
    registerSecretValueForRedaction(value);
  }
  const finishFailed = (errorText: string) =>
    context.capacity.finish({
      launchId: params.input.launchId,
      planHash: params.planHash,
      supervisor: params.supervisor,
      worker: null,
      state: "failed",
      errorText,
    });
  let adapter: NodeWorkerChildAdapter;
  let container: NodeWorkerContainerIdentity | undefined;
  let cleanupMode: NodeWorkerCleanupMode | null;
  try {
    const prepared = await prepareNodeWorkerLaunchTransport({
      bundleRoot: context.bundleRoot,
      workerEnv: context.workerEnv,
      engineEnv: context.engineEnv,
      nativeInferenceStartup: context.nativeInferenceStartup,
      input: params.input,
      descriptor: params.descriptor,
      planHash: params.planHash,
      supervisor: params.supervisor,
      connectionFailure,
      scrubber,
      store: context.store,
      containerEngine: context.containerEngine,
      containerLifecycle: context.containerLifecycle,
      containerImage: context.containerImage,
    });
    if (prepared.kind === "terminal") {
      return prepared.receipt;
    }
    adapter = prepared.adapter;
    container = prepared.container;
    cleanupMode = prepared.cleanupMode;
  } catch (error) {
    return finishFailed(
      sanitizeNodeWorkerDiagnostic(error, "node worker spawn failed", scrubber.scrub),
    );
  }
  if (!adapter.pid) {
    if (container) {
      await requireNodeWorkerContainerLifecycle(context.containerLifecycle).remove(
        container,
        params.input,
      );
    }
    adapter.kill("SIGKILL");
    adapter.dispose();
    return finishFailed("node worker spawn did not return a process id");
  }
  let worker: NodeWorkerProcessIdentity;
  try {
    worker = requireNodeWorkerProcessIdentity(adapter.pid);
  } catch (error) {
    if (container) {
      await requireNodeWorkerContainerLifecycle(context.containerLifecycle).remove(
        container,
        params.input,
      );
    }
    adapter.kill("SIGKILL");
    await adapter.wait().catch(() => undefined);
    adapter.dispose();
    return finishFailed(
      sanitizeNodeWorkerDiagnostic(
        error,
        "node worker process identity unavailable",
        scrubber.scrub,
      ),
    );
  }
  const { promise: journalReady, resolve: releaseJournal } = createDeferredCore();
  const active = {
    state: "running",
    binding: nodeWorkerEnvironmentBinding(params.input),
    turn: createNodeWorkerActiveTurn(params.claim),
    retiring: false,
    adapter,
    journalReady,
    gatewayNamespace: params.input.gatewayNamespace,
    launchId: params.input.launchId,
    planHash: params.planHash,
    scrubber,
    connectionFailure,
    supervisor: params.supervisor,
    worker,
    ...(container ? { container } : {}),
  } as NodeWorkerRunningChild; // SAFETY: done is assigned synchronously below; observation waits on journalReady before publishing state.
  active.done = context.observeChild(active);
  context.active.set(active.launchId, active);
  void active.done.catch(() => undefined);
  let running: NodeWorkerLaunchReceipt;
  try {
    running = await context.store.markRunning({
      launchId: active.launchId,
      planHash: active.planHash,
      supervisor: params.supervisor,
      worker,
      cleanupMode,
      ...(container ? { container } : {}),
    });
  } catch (error) {
    releaseJournal();
    if (container) {
      await context.stopChild(active, "interrupted");
      context.active.delete(active.launchId);
      await finishFailed(
        sanitizeNodeWorkerDiagnostic(
          error,
          "node worker container identity could not be persisted",
          scrubber.scrub,
        ),
      );
    } else {
      await context.stopChild(active, "interrupted").catch(() => undefined);
    }
    throw error;
  }
  releaseJournal();
  if (running.state === "cancelled" || running.state === "interrupted") {
    await context.stopChild(active, running.state);
    return (await context.store.get(active.launchId)) ?? running;
  }
  if (running.state !== "running") {
    if (container) {
      await context.stopChild(active, "interrupted");
    } else {
      adapter.closeStartGate?.();
    }
    return running;
  }
  if (context.isClosed() || params.signal?.aborted || active.turn?.cancelled) {
    await context.stopChild(active, context.isClosed() ? "interrupted" : "cancelled");
    return (await context.store.get(active.launchId)) ?? running;
  }
  try {
    await startNodeWorkerLaunchTransport({
      adapter,
      descriptor: params.descriptor,
      container,
      isCurrent: () =>
        context.active.get(active.launchId) === active &&
        !context.isClosed() &&
        !params.signal?.aborted &&
        active.turn?.cancelled === false,
    });
  } catch {
    // Only cancellation and shutdown override the child's observed exit.
    const stopState = context.isClosed()
      ? "interrupted"
      : params.signal?.aborted || active.turn?.cancelled
        ? "cancelled"
        : undefined;
    await context.stopChild(active, stopState);
    return (await context.store.get(active.launchId)) ?? running;
  }
  return (await context.turns.get(params.input.launchId)) ?? running;
}

export function requireNodeWorkerContainerLifecycle(
  lifecycle?: NodeWorkerContainerLifecycle,
): NodeWorkerContainerLifecycle {
  if (!lifecycle) {
    throw new Error("node worker container isolation has no available engine");
  }
  return lifecycle;
}

export async function cleanupNodeWorkerChildContainer(
  active: NodeWorkerRunningChild,
  lifecycle?: NodeWorkerContainerLifecycle,
): Promise<void> {
  if (!active.container) {
    return;
  }
  const cleanup = (active.containerCleanup ??= requireNodeWorkerContainerLifecycle(lifecycle)
    .remove(active.container, active)
    .finally(() => {
      if (active.containerCleanup === cleanup) {
        active.containerCleanup = undefined;
      }
    }));
  await cleanup;
}

export async function stopNodeWorkerChild(
  active: NodeWorkerRunningChild,
  state: NodeWorkerStopState | undefined,
  lifecycle?: NodeWorkerContainerLifecycle,
): Promise<void> {
  active.stopState ??= state;
  if (active.container) {
    // The attach client owns no workload; fence the container and prove its
    // removal before its launch can become terminal or release capacity.
    await cleanupNodeWorkerChildContainer(active, lifecycle);
  }
  active.adapter.kill("SIGTERM");
  const forceKill = setTimeout(() => active.adapter.kill("SIGKILL"), NODE_WORKER_STOP_GRACE_MS);
  forceKill.unref?.();
  try {
    await active.done;
  } finally {
    clearTimeout(forceKill);
  }
}
