import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  completeWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import { assertNativeInferenceAssignment } from "../worker/native-inference-startup.js";
import type { NativeInferenceStartup } from "../worker/native-inference-startup.js";
import {
  nodeWorkerPlanHash,
  validateNodeWorkerLaunchInput,
  type NodeWorkerEnvironmentStopInput,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
} from "../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerWorkspaceRetainInput,
  NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import type { NodeWorkerLaunchClaim } from "./node-worker-journal.types.js";
import { observeNodeWorkerChild } from "./node-worker-launch-observation.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import {
  cleanupNodeWorkerChildContainer,
  NODE_WORKER_STOP_GRACE_MS,
  requireNodeWorkerContainerLifecycle,
  startNodeWorkerChild,
  stopNodeWorkerChild,
} from "./node-worker-launch.js";
import {
  nodeWorkerNativeInferenceSecrets,
  snapshotNodeWorkerNativeInference,
} from "./node-worker-native-inference.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { settleNodeWorkerSupervisorClose } from "./node-worker-supervisor-close.js";
import {
  createNodeWorkerTerminalObserver,
  launchWithNodeWorkerPreparedWorkspace,
  nodeWorkerEnvironmentBinding,
  nodeWorkerEnvironmentKey,
  nodeWorkerEnvironmentMatches,
  nodeWorkerReceiptMatchesOwner,
  type NodeWorkerActiveOwnership,
  type NodeWorkerObservedTerminal,
  type NodeWorkerPendingAdmission,
  type NodeWorkerRunningChild,
  type NodeWorkerStopState,
  type NodeWorkerSupervisorOptions,
} from "./node-worker-supervisor-ownership.js";
import {
  createNodeWorkerLaunchRecovery,
  reconcileNodeWorkerTerminal,
  type NodeWorkerRecovery,
} from "./node-worker-supervisor-recovery.js";
import { stopOwnedNodeWorkerTree } from "./node-worker-tree-control.js";
import {
  createNodeWorkerTurnCancellation,
  settleNodeWorkerTurn,
  startNodeWorkerTurn,
  waitForNodeWorkerRetirement,
} from "./node-worker-turn-lifecycle.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const FORCE_STOP_WAIT_MS = 4_000;

/** Owns worker process groups, lifetime gates, and the durable node-host launch journal. */
class NodeWorkerSupervisor {
  private readonly active = new Map<string, NodeWorkerActiveOwnership>();
  private readonly observeTerminalOutcome = createNodeWorkerTerminalObserver(
    this.active,
    (observed) => this.reconcileActiveTerminal(observed),
  );
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  private readonly recoveries = new Map<string, NodeWorkerRecovery>();
  private readonly recoverRunning: ReturnType<typeof createNodeWorkerLaunchRecovery>;
  private readonly cancellation: ReturnType<typeof createNodeWorkerTurnCancellation>;
  private readonly bundleRoot: string;
  private readonly journal: NodeWorkerJournalWorker;
  private readonly store: NodeWorkerLaunchStore;
  private readonly turns: NodeWorkerTurnStore;
  private readonly admissions = new Map<string, NodeWorkerPendingAdmission>();
  private readonly retentions = new Set<Promise<NodeWorkerWorkspaceRetainResult>>();
  private readonly stoppingEnvironments = new Map<string, number>();
  private readonly nativeInferenceStartup?: NativeInferenceStartup;
  private readonly workerEnv: NodeJS.ProcessEnv;
  private readonly engineEnv: NodeJS.ProcessEnv;
  private readonly capacity: NodeWorkerCapacity;
  private readonly workspace: NodeWorkerWorkspaceRuntime;
  private readonly containerEngine?: NodeWorkerContainerEngine;
  private readonly containerLifecycle?: NodeWorkerContainerLifecycle;
  private readonly containerImage?: string;
  private supervisorIdentity?: NodeWorkerProcessIdentity;
  private initializationPromise?: Promise<void>;
  private closed = false;
  private closeCompleted = false;
  private closePromise?: Promise<void>;

  constructor(options: NodeWorkerSupervisorOptions = {}) {
    const env = options.env ?? process.env;
    this.nativeInferenceStartup = snapshotNodeWorkerNativeInference(
      options.nativeInferenceConfig,
      env,
    );
    this.bundleRoot = path.resolve(
      options.bundleRoot ?? path.join(resolveStateDir(env), "node-host"),
    );
    this.journal = new NodeWorkerJournalWorker({ env });
    this.store = new NodeWorkerLaunchStore(this.journal);
    this.turns = new NodeWorkerTurnStore(this.journal);
    this.workerEnv = snapshotNodeWorkerEnv(env);
    this.engineEnv = { ...process.env, ...env };
    this.containerEngine = options.containerEngine;
    this.containerLifecycle = options.containerEngine
      ? new NodeWorkerContainerLifecycle(options.containerEngine, this.bundleRoot, this.store)
      : undefined;
    this.containerImage = options.containerImage;
    this.workspace =
      options.workspace ??
      new NodeWorkerWorkspaceRuntime({ root: this.bundleRoot, env: this.workerEnv });
    this.capacity = new NodeWorkerCapacity(this.store, options);
    this.recoverRunning = createNodeWorkerLaunchRecovery({
      store: this.store,
      capacity: this.capacity,
      containerLifecycle: this.containerLifecycle,
      recoveries: this.recoveries,
      isRecoveryActive: () => !this.closed,
    });
    this.cancellation = createNodeWorkerTurnCancellation({
      admissions: this.admissions,
      active: this.active,
      turns: this.turns,
      launches: this.store,
      stopTimeoutMs: NODE_WORKER_STOP_GRACE_MS + FORCE_STOP_WAIT_MS,
      isClosed: () => this.closeCompleted,
      initialize: () => this.initialize(),
      status: (launchId) => this.status(launchId),
      cancelOwner: (identity) => this.cancelOwner(identity),
      stopChild: (active, state) => this.stopChild(active, state),
    });
  }

  initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    const initialization = (async () => {
      if (this.containerLifecycle) {
        await this.containerLifecycle.initialize();
      }
      await this.capacity.initialize(async (receipt) => {
        await this.recoverRunning(receipt, false);
      });
    })().catch((error: unknown) => {
      if (this.initializationPromise === initialization) {
        this.initializationPromise = undefined;
      }
      throw error;
    });
    return (this.initializationPromise = initialization);
  }

  async hasActiveWork(): Promise<boolean> {
    // Retained workers can own background commands after their turn completes;
    // durable claims also cover work owned by another live supervisor.
    const hasLocalWork = () =>
      !this.capacity.isInitialized() ||
      this.admissions.size > 0 ||
      this.starting.size > 0 ||
      this.recoveries.size > 0 ||
      this.retentions.size > 0 ||
      this.active.size > 0 ||
      this.stoppingEnvironments.size > 0 ||
      this.workspace.processes.hasActiveWork();
    if (hasLocalWork()) {
      return true;
    }
    const count = await this.store.nonterminalCount();
    return count > 0 || hasLocalWork();
  }

  async launch(
    rawInput: NodeWorkerLaunchInput,
    connectionEndpoint: WorkerConnectionEndpoint,
    signal?: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt> {
    const input = validateNodeWorkerLaunchInput(structuredClone(rawInput));
    const descriptor = completeWorkerLaunchDescriptor(input.descriptor, connectionEndpoint);
    const claimInput: NodeWorkerLaunchClaim = {
      launchId: input.launchId,
      planHash: nodeWorkerPlanHash(input),
      gatewayNamespace: input.gatewayNamespace,
      environmentId: descriptor.admission.environmentId,
      sessionId: descriptor.admission.sessionId,
      ownerEpoch: descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: descriptor.assignment.runId,
    };
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    const binding = nodeWorkerEnvironmentBinding(input);
    const key = nodeWorkerEnvironmentKey(binding);
    if (this.stoppingEnvironments.has(key)) {
      throw new Error("node worker environment is stopping");
    }
    const admission = this.admissions.get(key);
    if (admission) {
      if (admission.launchId !== input.launchId || admission.planHash !== claimInput.planHash) {
        throw new Error("node worker environment already has a turn being admitted");
      }
      return await admission.done;
    }
    const abort = new AbortController();
    const admissionSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const done = launchWithNodeWorkerPreparedWorkspace({
      workspace: this.workspace,
      request: { ...binding, sessionKey: input.sessionKey },
      signal: admissionSignal,
      isCurrent: () => !this.closed && !this.stoppingEnvironments.has(key),
      launch: (homeDir) =>
        this.launchAdmitted(input, descriptor, claimInput, admissionSignal, homeDir),
    });
    const pending = {
      binding,
      launchId: input.launchId,
      planHash: claimInput.planHash,
      identity: claimInput,
      abort,
      signal: admissionSignal,
      done,
    };
    this.admissions.set(key, pending);
    try {
      return await done;
    } finally {
      if (this.admissions.get(key) === pending) {
        this.admissions.delete(key);
      }
    }
  }

  private async launchAdmitted(
    input: NodeWorkerLaunchInput,
    descriptor: WorkerLaunchDescriptor,
    claimInput: NodeWorkerLaunchClaim,
    signal: AbortSignal,
    homeDir?: string,
  ): Promise<NodeWorkerLaunchReceipt> {
    await this.initialize();
    const supervisor = (this.supervisorIdentity ??= requireNodeWorkerProcessIdentity(process.pid));
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    signal.throwIfAborted();
    const previous = await this.turns.get(input.launchId);
    signal.throwIfAborted();
    if (previous) {
      await this.turns.claim({
        claim: claimInput,
        ownerLaunchId: previous.ownerLaunchId,
        supervisor: previous.supervisor,
        worker: previous.worker,
      });
      return (await this.status(input.launchId)) ?? previous;
    }
    const binding = nodeWorkerEnvironmentBinding(input);
    for (const owner of this.active.values()) {
      if (nodeWorkerEnvironmentKey(owner.binding) !== nodeWorkerEnvironmentKey(binding)) {
        continue;
      }
      if (owner.state === "observed") {
        await this.reconcileActiveTerminal(owner);
        continue;
      }
      await this.statusOwner(owner.launchId);
      await waitForNodeWorkerRetirement(owner, signal);
      signal.throwIfAborted();
      if (this.active.get(owner.launchId) !== owner) {
        continue;
      }
      if (owner.turn) {
        throw new Error("node worker environment already has an active turn");
      }
      if (owner.stopState || owner.retiring) {
        throw new Error("node worker environment cleanup is incomplete");
      }
      if (JSON.stringify(owner.binding) !== JSON.stringify(binding)) {
        if (
          binding.ownerEpoch < owner.binding.ownerEpoch ||
          (binding.ownerEpoch === owner.binding.ownerEpoch &&
            binding.placementGeneration < owner.binding.placementGeneration)
        ) {
          throw new Error("node worker launch belongs to a replaced environment");
        }
        await this.stopChild(owner, "interrupted");
        if (this.active.get(owner.launchId) === owner) {
          throw new Error("node worker environment cleanup is incomplete");
        }
        signal.throwIfAborted();
        continue;
      }
      if (descriptor.assignment.inference === "runtime-local") {
        if (!this.nativeInferenceStartup) {
          throw new Error("Node worker native inference requires node-local startup configuration");
        }
        assertNativeInferenceAssignment(this.nativeInferenceStartup, descriptor);
      }
      return await startNodeWorkerTurn({
        active: owner,
        descriptor,
        claim: claimInput,
        signal,
        store: this.turns,
        cancel: (expected) => this.cancellation.cancelTurn(expected),
        stopChild: (active, state) => this.stopChild(active, state),
        isCurrent: () => this.active.get(owner.launchId) === owner && !this.closed,
        additionalSecrets:
          descriptor.assignment.inference === "runtime-local" && this.nativeInferenceStartup
            ? nodeWorkerNativeInferenceSecrets(this.nativeInferenceStartup)
            : [],
      });
    }
    const claim = await this.capacity.claim(claimInput, supervisor, signal);
    if (claim.action === "recover") {
      await this.recoverRunning(claim.receipt);
    }
    if (claim.action !== "start") {
      // A pruned turn can share the first launch's ID. Its physical anchor is
      // cleanup authority, never a substitute receipt for that expired turn.
      throw new Error("node worker turn receipt expired; request a fresh turn");
    }
    try {
      await this.turns.claim(
        { claim: claimInput, ownerLaunchId: input.launchId, supervisor },
        { assertCurrent: () => signal.throwIfAborted() },
      );
    } catch (error) {
      await this.capacity.finish({
        ...claimInput,
        supervisor,
        worker: null,
        state: signal.aborted ? (this.closed ? "interrupted" : "cancelled") : "failed",
        errorText: signal.aborted
          ? "node worker admission closed before its turn was journaled"
          : "node worker turn could not be journaled",
      });
      throw error;
    }
    let cancellation: Promise<NodeWorkerLaunchReceipt | undefined> | undefined;
    const cancelClaimed = () => {
      cancellation ??= Promise.resolve().then(() => this.cancellation.cancelTurn(claimInput));
      void cancellation.catch(() => undefined);
    };
    signal?.addEventListener("abort", cancelClaimed, { once: true });
    const startup = startNodeWorkerChild(
      {
        bundleRoot: this.bundleRoot,
        workerEnv: homeDir ? snapshotNodeWorkerEnv(this.workerEnv, homeDir) : this.workerEnv,
        engineEnv: this.engineEnv,
        nativeInferenceStartup: this.nativeInferenceStartup,
        store: this.store,
        turns: this.turns,
        capacity: this.capacity,
        containerEngine: this.containerEngine,
        containerImage: this.containerImage,
        containerLifecycle: this.containerLifecycle,
        active: this.active,
        isClosed: () => this.closed,
        observeChild: (active) => this.observeChild(active),
        stopChild: (active, state) => this.stopChild(active, state),
      },
      {
        input,
        descriptor,
        planHash: claimInput.planHash,
        supervisor,
        signal,
        claim: claimInput,
      },
    );
    this.starting.set(input.launchId, startup);
    if (signal?.aborted) {
      cancelClaimed();
    }
    try {
      const receipt = await startup;
      return cancellation ? ((await cancellation) ?? receipt) : receipt;
    } finally {
      signal?.removeEventListener("abort", cancelClaimed);
      if (this.starting.get(input.launchId) === startup) {
        this.starting.delete(input.launchId);
      }
    }
  }

  async status(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
    if (this.closeCompleted) {
      return this.turns.get(launchId);
    }
    await this.initialize();
    const turn = await this.turns.get(launchId);
    if (turn) {
      const owner = this.active.get(turn.ownerLaunchId);
      if (
        !this.closeCompleted &&
        (!owner ||
          owner.state === "observed" ||
          (owner.state === "running" && owner.deferredOutcome) ||
          turn.state === "pending" ||
          turn.state === "running")
      ) {
        await this.statusOwner(turn.ownerLaunchId);
      }
      return this.turns.get(launchId);
    }
    return undefined;
  }

  private async statusOwner(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.initialize();
    const active = this.active.get(launchId);
    if (active?.state === "observed") {
      return this.reconcileActiveTerminal(active);
    }
    if (active?.state === "running") {
      if (active.deferredOutcome && !active.container) {
        await this.reconcileDeferredOutcome(active);
        return this.store.get(launchId);
      }
      if (active.container) {
        const lifecycle = requireNodeWorkerContainerLifecycle(this.containerLifecycle);
        const inspection = await lifecycle.inspect(active.container, active);
        if (inspection === "unknown") {
          return this.store.get(launchId);
        }
        if (inspection === "reused") {
          throw new Error(`node worker launch ${launchId} lost its container ownership`);
        }
        if (inspection === "live") {
          const clientState = inspectNodeWorkerProcessIdentity(active.worker);
          if (clientState !== "dead" && clientState !== "reused") {
            return this.store.get(launchId);
          }
          // Observe the dead attach client's result before fencing its still-running owner.
          await active.done;
          if (this.active.get(launchId) === active) {
            await this.stopChild(active, "interrupted");
          }
        } else {
          await cleanupNodeWorkerChildContainer(active, this.containerLifecycle);
          await active.done;
          await this.reconcileDeferredOutcome(active);
        }
        const observed = this.active.get(launchId);
        return observed?.state === "observed"
          ? this.reconcileActiveTerminal(observed)
          : this.store.get(launchId);
      }
      const workerState = inspectNodeWorkerProcessIdentity(active.worker);
      if (workerState === "dead" || workerState === "reused") {
        await stopOwnedNodeWorkerTree(active.worker, NODE_WORKER_STOP_GRACE_MS, FORCE_STOP_WAIT_MS);
        await active.done;
        const observed = this.active.get(launchId);
        if (observed?.state === "observed") {
          return this.reconcileActiveTerminal(observed);
        }
      }
      return this.store.get(launchId);
    }
    const receipt = await this.store.get(launchId);
    return receipt?.state === "running" ? await this.recoverRunning(receipt) : receipt;
  }

  async retainWorkspaces(
    input: NodeWorkerWorkspaceRetainInput,
    signal?: AbortSignal,
  ): Promise<NodeWorkerWorkspaceRetainResult> {
    if (this.closed) {
      throw new Error("node worker supervisor is closed");
    }
    const operation = (async () => {
      await this.initialize();
      return await this.workspace.applyRetainSnapshot(
        input,
        () => this.store.listNonterminal(),
        signal,
      );
    })();
    this.retentions.add(operation);
    try {
      return await operation;
    } finally {
      this.retentions.delete(operation);
    }
  }

  cancel(expected: NodeWorkerSupervisorIdentity): Promise<NodeWorkerLaunchReceipt | undefined> {
    return this.cancellation.cancel(expected);
  }

  async stopEnvironment(expected: NodeWorkerEnvironmentStopInput): Promise<void> {
    const key = nodeWorkerEnvironmentKey(expected);
    this.stoppingEnvironments.set(key, (this.stoppingEnvironments.get(key) ?? 0) + 1);
    try {
      const errors: unknown[] = [];
      const admission = this.admissions.get(key);
      const matchingAdmission =
        admission && nodeWorkerEnvironmentMatches(admission.binding, expected)
          ? admission
          : undefined;
      matchingAdmission?.abort.abort(new Error("node worker environment stopped"));
      await this.workspace.processes
        .stopEnvironment(expected)
        .catch((error: unknown) => errors.push(error));
      await this.initialize().catch((error: unknown) => errors.push(error));
      let durableStops: Promise<void>[] = [];
      try {
        durableStops = (await this.store.listNonterminal()).map(async (owner) => {
          if (!nodeWorkerEnvironmentMatches(owner, expected)) {
            return;
          }
          if (
            matchingAdmission?.launchId === owner.launchId &&
            matchingAdmission.planHash === owner.planHash
          ) {
            await matchingAdmission.done.catch(() => undefined);
          }
          const active = this.active.get(owner.launchId);
          if (active && nodeWorkerEnvironmentMatches(active.binding, expected)) {
            return;
          }
          await this.cancelOwner(owner, true);
          const remaining = await this.store.get(owner.launchId);
          if (remaining?.state === "pending" || remaining?.state === "running") {
            throw new Error("node worker environment is still owned by another supervisor");
          }
        });
      } catch (error) {
        errors.push(error);
      }
      const durableResults = Promise.allSettled(durableStops);
      // Admission owns its cancellation order and can materialize a child after abort.
      await matchingAdmission?.done.catch(() => undefined);
      for (const owner of this.active.values()) {
        if (!nodeWorkerEnvironmentMatches(owner.binding, expected)) {
          continue;
        }
        try {
          if (owner.state === "running") {
            await this.stopChild(owner, "interrupted");
          }
          const observed = this.active.get(owner.launchId);
          if (observed?.state === "observed") {
            await this.reconcileActiveTerminal(observed);
          } else if (observed) {
            throw new Error("node worker environment cleanup is incomplete");
          }
        } catch (error) {
          errors.push(error);
        }
      }
      errors.push(
        ...(await durableResults).flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
      );
      if (errors.length > 0) {
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "node worker environment cleanup failed");
      }
    } finally {
      const remaining = this.stoppingEnvironments.get(key)! - 1;
      if (remaining === 0) {
        this.stoppingEnvironments.delete(key);
      } else {
        this.stoppingEnvironments.set(key, remaining);
      }
    }
  }

  private async cancelOwner(
    expected: NodeWorkerSupervisorIdentity,
    awaitCleanup = false,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    const receipt = await this.store.getMatching(expected);
    if (!receipt || (receipt.state !== "pending" && receipt.state !== "running")) {
      return receipt;
    }
    const active = this.active.get(expected.launchId);
    if (active) {
      if (
        active.planHash !== expected.planHash ||
        !nodeWorkerReceiptMatchesOwner(receipt, active.supervisor, active.worker, active.container)
      ) {
        return receipt;
      }
      if (active.state === "running") {
        await this.stopChild(active, "cancelled");
      }
      const observed = this.active.get(expected.launchId);
      if (observed?.state === "observed") {
        return this.reconcileActiveTerminal(observed);
      }
      return this.store.getMatching(expected);
    }
    const startup = this.starting.get(expected.launchId);
    if (startup && receipt.state === "pending" && receipt.supervisor.pid === process.pid) {
      if (this.containerEngine) {
        // Startup may already own a container while its create/start client is
        // in flight; retain the durable slot until normal cancellation fences it.
        await startup;
        return await this.cancelOwner(expected, awaitCleanup);
      }
      const cancelled = await this.capacity.finishCancelled({
        expected,
        supervisor: receipt.supervisor,
        worker: null,
      });
      await startup;
      return (await this.store.getMatching(expected)) ?? cancelled;
    }
    if (startup && receipt.container && receipt.supervisor.pid === process.pid) {
      await startup;
      return await this.cancelOwner(expected, awaitCleanup);
    }
    return await this.recoverRunning(receipt, true, "cancelled", awaitCleanup);
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.capacity.close();
    for (const admission of this.admissions.values()) {
      admission.abort.abort(new Error("node worker supervisor is closed"));
    }
    const operation = settleNodeWorkerSupervisorClose({
      workspace: this.workspace,
      initialization: this.initializationPromise,
      admissions: this.admissions,
      starting: this.starting,
      recoveries: this.recoveries,
      retentions: this.retentions,
      active: this.active,
      journal: this.journal,
      stopChild: (active) => this.stopChild(active, "interrupted"),
      reconcileTerminal: (active) => this.reconcileActiveTerminal(active),
    }).then(() => {
      this.closeCompleted = true;
    });
    const closePromise = operation.finally(() => {
      if (this.closePromise === closePromise) {
        this.closePromise = undefined;
      }
    });
    return (this.closePromise = closePromise);
  }

  private reconcileActiveTerminal(
    active: NodeWorkerObservedTerminal,
  ): Promise<NodeWorkerLaunchReceipt> {
    return reconcileNodeWorkerTerminal(
      { active: this.active, turns: this.turns, capacity: this.capacity },
      active,
    );
  }

  private async observeChild(active: NodeWorkerRunningChild): Promise<void> {
    const observation = await observeNodeWorkerChild(
      active,
      (frame) => settleNodeWorkerTurn(active, frame, this.turns),
      () => active.turn?.claim.launchId,
      active.container
        ? () => cleanupNodeWorkerChildContainer(active, this.containerLifecycle)
        : undefined,
    );
    if (observation.kind === "deferred") {
      active.deferredOutcome = observation.outcome;
      return;
    }
    active.adapter.dispose();
    await this.observeTerminalOutcome(active, observation.outcome);
  }

  private async reconcileDeferredOutcome(active: NodeWorkerRunningChild): Promise<void> {
    if (!active.deferredOutcome) {
      return;
    }
    if (!active.container && !active.adapter.confirmExtinction?.()) {
      throw new Error(
        "node worker process cleanup remains unconfirmed; retry status after cleanup finishes",
        { cause: active.deferredOutcome.errorText },
      );
    }
    active.adapter.dispose();
    await this.observeTerminalOutcome(active, active.deferredOutcome);
  }

  private async stopChild(
    active: NodeWorkerRunningChild,
    state?: NodeWorkerStopState,
  ): Promise<void> {
    await stopNodeWorkerChild(active, state, this.containerLifecycle);
    await this.reconcileDeferredOutcome(active);
  }
}

export function createNodeWorkerSupervisor(
  options: NodeWorkerSupervisorOptions = {},
): NodeWorkerSupervisor {
  return new NodeWorkerSupervisor(options);
}
