import { addAbortListener } from "node:events";
import path from "node:path";
import { NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { resolveStateDir } from "../config/paths.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withTimeout } from "../infra/fs-safe.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  completeWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../worker/launch-descriptor.js";
import {
  nodeWorkerPlanHash,
  nodeWorkerTurnMatchesIdentity,
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
import {
  buildWorkerProcessTurn,
  type WorkerProcessMessage,
} from "../worker/worker-process-protocol.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import type { NodeWorkerLaunchClaim } from "./node-worker-journal.types.js";
import {
  observeNodeWorkerChild,
  type NodeWorkerTerminalOutcome,
} from "./node-worker-launch-observation.js";
import type { NodeWorkerCleanupMode } from "./node-worker-launch-receipt.js";
import {
  NodeWorkerLaunchStore,
  type NodeWorkerLaunchReceipt,
  type NodeWorkerContainerIdentity,
} from "./node-worker-launch-store.js";
import {
  prepareNodeWorkerLaunchTransport,
  sendNodeWorkerInput,
  type NodeWorkerChildAdapter,
} from "./node-worker-launch-transport.js";
import {
  createNodeWorkerCredentialScrubber,
  sanitizeNodeWorkerDiagnostic,
} from "./node-worker-output.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  clearNodeWorkerRetention,
  createNodeWorkerObservedTerminal,
  createNodeWorkerActiveTurn,
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
  type NodeWorkerRecovery,
} from "./node-worker-supervisor-recovery.js";
import { stopOwnedNodeWorkerTree } from "./node-worker-tree-control.js";
import { nodeWorkerDescriptorSecrets } from "./node-worker-turn-lifecycle.js";
import { NodeWorkerTurnStore, type NodeWorkerTurnReceipt } from "./node-worker-turn-store.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const NODE_WORKER_STOP_GRACE_MS = 1_000;
const FORCE_STOP_WAIT_MS = 4_000;

/** Owns worker process groups, lifetime gates, and the durable node-host launch journal. */
class NodeWorkerSupervisor {
  private readonly active = new Map<string, NodeWorkerActiveOwnership>();
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  private readonly recoveries = new Map<string, NodeWorkerRecovery>();
  private readonly recoverRunning: ReturnType<typeof createNodeWorkerLaunchRecovery>;
  private readonly bundleRoot: string;
  private readonly journal: NodeWorkerJournalWorker;
  private readonly store: NodeWorkerLaunchStore;
  private readonly turns: NodeWorkerTurnStore;
  private readonly admissions = new Map<string, NodeWorkerPendingAdmission>();
  private readonly retentions = new Set<Promise<NodeWorkerWorkspaceRetainResult>>();
  private readonly stoppingEnvironments = new Map<string, number>();
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
  private idleGeneration = 0;

  constructor(options: NodeWorkerSupervisorOptions = {}) {
    const env = options.env ?? process.env;
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
    const hasLocalWork = () =>
      !this.capacity.isInitialized() ||
      this.admissions.size > 0 ||
      this.starting.size > 0 ||
      this.recoveries.size > 0 ||
      this.retentions.size > 0 ||
      this.active.size > this.idleChildren().length ||
      this.stoppingEnvironments.size > 0 ||
      this.workspace.processes.hasActiveWork() ||
      this.workspace.quiescence.hasActiveWork();
    if (hasLocalWork()) {
      return true;
    }
    const count = await this.store.nonterminalCount();
    return count > this.idleChildren().length || hasLocalWork();
  }

  private idleChildren(): NodeWorkerRunningChild[] {
    return [...this.active.values()]
      .filter(
        (owner): owner is NodeWorkerRunningChild =>
          owner.state === "running" &&
          !owner.turn &&
          !owner.retiring &&
          !owner.stopState &&
          owner.retention?.reason === "idle",
      )
      .toSorted(
        (a, b) =>
          (a.retention?.reason === "idle" ? a.retention.since : 0) -
          (b.retention?.reason === "idle" ? b.retention.since : 0),
      );
  }

  private publishIdle(): void {
    this.capacity.setReclaimableIdle(this.idleChildren().length);
  }

  private async reclaimIdle(): Promise<boolean> {
    const oldest = this.idleChildren()[0];
    if (!oldest) {
      return false;
    }
    await this.stopChild(oldest, "interrupted");
    return !this.active.has(oldest.launchId);
  }

  async retireIdle(): Promise<void> {
    this.idleGeneration++;
    await Promise.allSettled([...this.admissions.values()].map((admission) => admission.done));
    const results = await Promise.allSettled(
      [...this.active.values()].flatMap((owner) =>
        owner.state === "running" && owner.retention?.reason === "idle"
          ? [this.stopChild(owner, "interrupted")]
          : [],
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "node worker idle cleanup failed");
    }
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
      const { launchId, planHash } = admission.identity;
      if (launchId !== input.launchId || planHash !== claimInput.planHash) {
        throw new Error("node worker environment already has a turn being admitted");
      }
      return await admission.done;
    }
    const abort = new AbortController();
    const idleGeneration =
      input.idleRetention &&
      descriptor.admission.handshake.protocolFeatures.includes(
        NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
      )
        ? this.idleGeneration
        : undefined;
    const admissionSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const done = (async () => {
      const workspace = await this.workspace.acquirePreparedWorkspace({
        ...binding,
        sessionKey: input.sessionKey,
      });
      try {
        admissionSignal.throwIfAborted();
        if (this.closed || this.stoppingEnvironments.has(key)) {
          throw new Error("node worker environment is stopping");
        }
        return await this.launchAdmitted(
          input,
          descriptor,
          claimInput,
          admissionSignal,
          workspace?.homeDir,
          idleGeneration,
        );
      } finally {
        workspace?.release();
      }
    })();
    const pending = {
      binding,
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
    idleGeneration?: number,
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
      signal.throwIfAborted();
      if (owner.retiring) {
        // Shutdown must abort admission before stopping its retiring physical owner.
        const aborted = createDeferredCore();
        const listener = addAbortListener(signal, () => aborted.resolve());
        try {
          await Promise.race([owner.done, aborted.promise]);
        } finally {
          listener[Symbol.dispose]();
        }
      }
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
      return await this.startTurn(owner, descriptor, claimInput, signal, idleGeneration);
    }
    const claim = await this.capacity.claim(claimInput, supervisor, signal, () =>
      this.reclaimIdle(),
    );
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
      cancellation ??= Promise.resolve().then(() => this.cancelTurn(claimInput));
      void cancellation.catch(() => undefined);
    };
    signal?.addEventListener("abort", cancelClaimed, { once: true });
    const startup = this.startChild({
      workerEnv: homeDir ? snapshotNodeWorkerEnv(this.workerEnv, homeDir) : this.workerEnv,
      input,
      descriptor,
      planHash: claimInput.planHash,
      supervisor,
      signal,
      claim: claimInput,
      idleGeneration,
    });
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

  /** Starts one physical owner behind the durable journal gate, independent of turn reuse. */
  private async startChild(params: {
    workerEnv: NodeJS.ProcessEnv;
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    claim: NodeWorkerLaunchClaim;
    signal?: AbortSignal;
    idleGeneration?: number;
  }): Promise<NodeWorkerLaunchReceipt> {
    const sensitiveValues = nodeWorkerDescriptorSecrets(params.descriptor);
    const scrubber = createNodeWorkerCredentialScrubber(sensitiveValues);
    // Turn cancellation can beat the child's admission retry deadline. Retain the
    // producer's latest cause so the durable terminal receipt does not become generic.
    const connectionFailure: { errorText?: string } = {};
    for (const value of sensitiveValues) {
      registerSecretValueForRedaction(value);
    }
    const finishFailed = (errorText: string) =>
      this.capacity.finish({
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
        bundleRoot: this.bundleRoot,
        workerEnv: params.workerEnv,
        engineEnv: this.engineEnv,
        input: params.input,
        descriptor: params.descriptor,
        planHash: params.planHash,
        supervisor: params.supervisor,
        connectionFailure,
        scrubber,
        store: this.store,
        containerEngine: this.containerEngine,
        containerLifecycle: this.containerLifecycle,
        containerImage: this.containerImage,
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
        await this.requireContainerLifecycle().remove(container, params.input);
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
        await this.requireContainerLifecycle().remove(container, params.input);
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
      idleGeneration: params.idleGeneration,
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
    active.done = this.observeChild(active);
    this.active.set(active.launchId, active);
    void active.done.catch(() => undefined);
    let running: NodeWorkerLaunchReceipt;
    try {
      running = await this.store.markRunning({
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
        await this.stopChild(active, "interrupted");
        this.active.delete(active.launchId);
        await finishFailed(
          sanitizeNodeWorkerDiagnostic(
            error,
            "node worker container identity could not be persisted",
            scrubber.scrub,
          ),
        );
      } else {
        await this.stopChild(active, "interrupted").catch(() => undefined);
      }
      throw error;
    }
    releaseJournal();
    if (running.state === "cancelled" || running.state === "interrupted") {
      await this.stopChild(active, running.state);
      return (await this.store.get(active.launchId)) ?? running;
    }
    if (running.state !== "running") {
      if (container) {
        await this.stopChild(active, "interrupted");
      } else {
        adapter.closeStartGate?.();
      }
      return running;
    }
    if (this.closed || params.signal?.aborted || active.turn?.cancelled) {
      await this.stopChild(active, this.closed ? "interrupted" : "cancelled");
      return (await this.store.get(active.launchId)) ?? running;
    }
    try {
      const isCurrent = () =>
        this.active.get(active.launchId) === active &&
        !this.closed &&
        !params.signal?.aborted &&
        active.turn?.cancelled === false;
      if (!isCurrent()) {
        throw new Error("node worker admission closed before startup");
      }
      if (!container) {
        await adapter.openStartGate?.();
      }
      if (!isCurrent()) {
        throw new Error("node worker admission closed before descriptor dispatch");
      }
      await sendNodeWorkerInput(
        adapter,
        buildWorkerProcessTurn(params.descriptor, params.idleGeneration !== undefined),
      );
    } catch {
      // Only cancellation and shutdown override the child's observed exit.
      const stopState = this.closed
        ? "interrupted"
        : params.signal?.aborted || active.turn?.cancelled
          ? "cancelled"
          : undefined;
      await this.stopChild(active, stopState);
      return (await this.store.get(active.launchId)) ?? running;
    }
    return (await this.turns.get(params.input.launchId)) ?? running;
  }

  private async startTurn(
    active: NodeWorkerRunningChild,
    descriptor: WorkerLaunchDescriptor,
    claim: NodeWorkerLaunchClaim,
    signal: AbortSignal,
    idleGeneration?: number,
  ): Promise<NodeWorkerLaunchReceipt> {
    const isCurrent = () => this.active.get(active.launchId) === active && !this.closed;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!isCurrent() || active.stopState || active.retiring || active.turn) {
        throw new Error("node worker turn lost its physical owner before admission");
      }
    };
    assertCurrent();
    const admitted = await this.turns.claim(
      {
        claim,
        ownerLaunchId: active.launchId,
        supervisor: active.supervisor,
        worker: active.worker,
      },
      { assertCurrent },
    );
    if (admitted.action === "replay") {
      return admitted.receipt;
    }
    clearNodeWorkerRetention(active);
    active.turn = createNodeWorkerActiveTurn(claim);
    const negotiated = active.idleGeneration !== undefined || idleGeneration !== undefined;
    active.idleGeneration = idleGeneration;
    if (negotiated) {
      this.publishIdle();
    }
    if (signal.aborted || !isCurrent() || active.stopState || active.retiring) {
      await this.stopChild(active, signal.aborted ? "cancelled" : "interrupted");
      return (await this.turns.get(claim.launchId)) ?? admitted.receipt;
    }
    const secrets = nodeWorkerDescriptorSecrets(descriptor);
    for (const value of secrets) {
      registerSecretValueForRedaction(value);
    }
    // The IPC diagnostic handler shares this object, so rotate its contents rather than its owner.
    Object.assign(active.scrubber, createNodeWorkerCredentialScrubber(secrets));
    active.connectionFailure.errorText = undefined;
    const onAbort = () => {
      void this.cancelTurn(claim).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await sendNodeWorkerInput(
        active.adapter,
        buildWorkerProcessTurn(descriptor, active.idleGeneration !== undefined),
      );
      if (signal.aborted) {
        await this.cancelTurn(claim);
      }
    } catch {
      await this.stopChild(active, "interrupted");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    return (await this.turns.get(claim.launchId)) ?? admitted.receipt;
  }

  async status(
    launchId: string,
    options?: { waitMs: number; signal?: AbortSignal },
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    options?.signal?.throwIfAborted();
    let current = await this.readStatus(launchId);
    if (!options || !current || (current.state !== "pending" && current.state !== "running")) {
      return current;
    }
    const elapsed = createDeferredCore<boolean>();
    const timer = setTimeout(() => elapsed.resolve(false), options.waitMs);
    timer.unref();
    try {
      while (current && (current.state === "pending" || current.state === "running")) {
        const turn: NodeWorkerActiveOwnership["turn"] = this.active.get(
          current.ownerLaunchId,
        )?.turn;
        const admission = this.admissions.get(nodeWorkerEnvironmentKey(current));
        // A journaled turn can precede its live owner. Follow admission into settlement.
        const done: Promise<unknown> | undefined =
          turn?.claim.launchId === launchId
            ? turn.done
            : admission?.identity.launchId === launchId &&
                admission.identity.planHash === current.planHash
              ? admission.done.catch(() => undefined)
              : undefined;
        // Completion can publish between the journal read and capturing the live owner.
        current = await this.readStatus(launchId);
        if (!current || (current.state !== "pending" && current.state !== "running")) {
          break;
        }
        const notified: boolean = await racePromiseWithAbortSignal(
          done ? Promise.race([done.then(() => true), elapsed.promise]) : elapsed.promise,
          options.signal,
        );
        options.signal?.throwIfAborted();
        // Settlement follows persistence; a timed-out observation also reconciles recovery.
        current = await (notified ? this.turns.get(launchId) : this.readStatus(launchId));
        if (!notified) {
          break;
        }
      }
      return current;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readStatus(launchId: string): Promise<NodeWorkerTurnReceipt | undefined> {
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
        const lifecycle = this.requireContainerLifecycle();
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
          await this.cleanupChildContainer(active);
          await active.done;
          await this.reconcileDeferredOutcome(active);
        }
      } else {
        const workerState = inspectNodeWorkerProcessIdentity(active.worker);
        if (workerState === "dead" || workerState === "reused") {
          await stopOwnedNodeWorkerTree(
            active.worker,
            NODE_WORKER_STOP_GRACE_MS,
            FORCE_STOP_WAIT_MS,
          );
          await active.done;
        }
      }
      const observed = this.active.get(launchId);
      return observed?.state === "observed"
        ? this.reconcileActiveTerminal(observed)
        : this.store.get(launchId);
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

  /** External cancellation joins admission; startup invokes only the turn primitive. */
  async cancel(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    const admission = [...this.admissions.values()].find((pending) =>
      nodeWorkerTurnMatchesIdentity(pending.identity, expected),
    );
    const cancellation = this.cancelTurn(expected);
    if (!admission) {
      return cancellation;
    }
    const [cancelled, admitted] = await Promise.allSettled([cancellation, admission.done]);
    if (cancelled.status === "rejected") {
      throw cancelled.reason;
    }
    if (
      admitted.status === "rejected" &&
      (!admission.signal.aborted || admitted.reason !== admission.signal.reason)
    ) {
      throw admitted.reason;
    }
    return this.turns.getMatching(expected);
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
            matchingAdmission?.identity.launchId === owner.launchId &&
            matchingAdmission.identity.planHash === owner.planHash
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

  private async cancelTurn(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    if (this.closeCompleted) {
      return this.turns.getMatching(expected);
    }
    const afterSettlement = async (settling: Promise<void>) => {
      try {
        await settling;
      } catch {
        return await this.cancelTurn(expected);
      }
      return this.turns.getMatching(expected);
    };
    let settling: Promise<void> | undefined;
    let matched:
      | {
          owner: NodeWorkerRunningChild;
          turn: NonNullable<NodeWorkerRunningChild["turn"]>;
        }
      | undefined;
    for (const admission of this.admissions.values()) {
      if (nodeWorkerTurnMatchesIdentity(admission.identity, expected)) {
        admission.abort.abort(new Error("node worker turn cancelled"));
      }
    }
    for (const owner of this.active.values()) {
      if (
        owner.state === "running" &&
        owner.turn &&
        nodeWorkerTurnMatchesIdentity(owner.turn.claim, expected)
      ) {
        matched = { owner, turn: owner.turn };
        if (owner.turn.settling) {
          settling = owner.turn.settling;
        } else {
          // The start gate must close before journal admission can yield.
          owner.turn.cancelled = true;
        }
      }
    }
    if (settling) {
      return await afterSettlement(settling);
    }
    await this.initialize();
    const receipt = await this.turns.getMatching(expected);
    if (!receipt || (receipt.state !== "pending" && receipt.state !== "running")) {
      return receipt ? await this.status(receipt.launchId) : undefined;
    }
    if (matched?.turn.settling) {
      return await afterSettlement(matched.turn.settling);
    }
    if (
      matched &&
      (this.active.get(matched.owner.launchId) !== matched.owner ||
        matched.owner.turn !== matched.turn)
    ) {
      return this.status(expected.launchId);
    }
    const active = this.active.get(receipt.ownerLaunchId);
    if (active?.state !== "running" || active.turn?.claim.launchId !== expected.launchId) {
      const owner = await this.store.get(receipt.ownerLaunchId);
      if (owner) {
        await this.cancelOwner(owner);
      }
      return this.turns.getMatching(expected);
    }
    const turn = active.turn;
    if (turn.settling) {
      return await afterSettlement(turn.settling);
    }
    turn.cancelled = true;
    try {
      // A worker that stopped reading can block the write as well as the reply.
      await withTimeout(
        sendNodeWorkerInput(active.adapter, { type: "cancel", turnId: expected.launchId }).then(
          () => turn.done,
        ),
        NODE_WORKER_STOP_GRACE_MS + FORCE_STOP_WAIT_MS,
        { message: "node worker turn cancellation did not settle" },
      );
    } catch {
      if (this.active.get(active.launchId) === active && active.turn === turn) {
        await this.stopChild(active, "cancelled");
      }
    }
    if (this.active.get(active.launchId)?.state === "observed") {
      return this.status(expected.launchId);
    }
    return this.turns.getMatching(expected);
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
    if (startup && receipt.supervisor.pid === process.pid) {
      if (receipt.container || (receipt.state === "pending" && this.containerEngine)) {
        // Startup may already own a container while its create/start client is
        // in flight; retain the durable slot until normal cancellation fences it.
        await startup;
        return await this.cancelOwner(expected, awaitCleanup);
      }
      if (receipt.state === "pending") {
        const cancelled = await this.capacity.finishCancelled({
          expected,
          supervisor: receipt.supervisor,
          worker: null,
        });
        await startup;
        return (await this.store.getMatching(expected)) ?? cancelled;
      }
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
    const operation = this.settleClose().then(() => {
      this.closeCompleted = true;
    });
    const closePromise = operation.finally(() => {
      if (this.closePromise === closePromise) {
        this.closePromise = undefined;
      }
    });
    return (this.closePromise = closePromise);
  }

  /** Join accepted work and physical cleanup before sealing the journal. */
  private async settleClose(): Promise<void> {
    const initialization = this.initializationPromise;
    const errors: unknown[] = [];
    await this.workspace.quiescence.close().catch((error: unknown) => errors.push(error));
    await this.workspace.processes.close().catch((error: unknown) => errors.push(error));
    await initialization?.catch((error: unknown) => errors.push(error));
    await Promise.allSettled([...this.admissions.values()].map((admission) => admission.done));
    await Promise.allSettled(this.starting.values());
    await Promise.allSettled(this.retentions);
    const stopped = await Promise.allSettled([
      ...[...this.recoveries.values()].map((recovery) => recovery.done),
      ...[...this.active.values()]
        .filter((active): active is NodeWorkerRunningChild => active.state === "running")
        .map((active) => this.stopChild(active, "interrupted")),
    ]);
    errors.push(
      ...stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    for (const active of this.active.values()) {
      if (active.state !== "observed") {
        continue;
      }
      try {
        await this.reconcileActiveTerminal(active);
      } catch (error) {
        errors.push(error);
      }
    }
    await this.journal
      .drain({ close: errors.length === 0 })
      .catch((error: unknown) => errors.push(error));
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "node worker terminal reconciliation failed");
    }
  }

  private reconcileActiveTerminal(
    active: NodeWorkerObservedTerminal,
  ): Promise<NodeWorkerLaunchReceipt> {
    if (active.reconciliation) {
      return active.reconciliation;
    }
    const operation = (async () => {
      if (active.cancelledTurn) {
        // Gateway authority may close before worker finishing. The physical failure
        // remains separate, and neither journal can settle before process cleanup.
        const turn = await this.turns.finish({
          expected: active.cancelledTurn,
          ownerLaunchId: active.launchId,
          supervisor: active.supervisor,
          worker: active.worker,
          state: "cancelled",
          errorText: active.outcome.errorText ?? "node worker turn cancelled",
        });
        if (!turn || turn.state === "pending" || turn.state === "running") {
          throw new Error("node worker cancellation lost its physical owner");
        }
      }
      const receipt = await this.capacity.finish({
        launchId: active.launchId,
        planHash: active.planHash,
        supervisor: active.supervisor,
        worker: active.worker,
        ...active.outcome,
      });
      if (receipt.state === "pending" || receipt.state === "running") {
        throw new Error(`node worker launch ${active.launchId} terminal state was not persisted`);
      }
      active.turn?.settle();
      active.turn = undefined;
      if (this.active.get(active.launchId) === active) {
        this.active.delete(active.launchId);
      }
      return receipt;
    })();
    const pending = operation.finally(() => {
      if (active.reconciliation === pending) {
        active.reconciliation = undefined;
      }
    });
    active.reconciliation = pending;
    return pending;
  }

  private async observeChild(active: NodeWorkerRunningChild): Promise<void> {
    const observation = await observeNodeWorkerChild(
      active,
      (frame) => this.settleTurn(active, frame),
      () => active.turn?.claim.launchId,
      active.container ? () => this.cleanupChildContainer(active) : undefined,
    );
    if (observation.kind === "deferred") {
      active.deferredOutcome = observation.outcome;
      return;
    }
    active.adapter.dispose();
    await this.observeTerminalOutcome(active, observation.outcome);
  }

  private async settleTurn(
    active: NodeWorkerRunningChild,
    frame: WorkerProcessMessage,
  ): Promise<void> {
    if (frame.type === "result") {
      if (active.stopState) {
        return;
      }
      const turn = active.turn;
      if (!turn || turn.claim.launchId !== frame.turnId || active.retiring) {
        throw new Error("node worker returned a result outside its active turn");
      }
      // Publish this operation before finish can invoke a reentrant cancellation.
      const settling = Promise.resolve()
        .then(async () => {
          const receipt = await this.turns.finish({
            expected: turn.claim,
            ownerLaunchId: active.launchId,
            supervisor: active.supervisor,
            worker: active.worker,
            ...(turn.cancelled
              ? ({
                  state: "cancelled",
                  errorText: active.connectionFailure.errorText ?? "node worker turn cancelled",
                } as const)
              : ({ state: "completed", resultJson: JSON.stringify(frame.result) } as const)),
          });
          if (!receipt || receipt.state === "pending" || receipt.state === "running") {
            throw new Error("node worker turn completion lost its physical owner");
          }
          active.turn = undefined;
          active.retiring = !frame.retainWorker;
          turn.settle();
        })
        .finally(() => {
          if (turn.settling === settling) {
            turn.settling = undefined;
          }
        });
      turn.settling = settling;
      await settling;
    } else if (active.turn || active.retention?.turnId !== frame.turnId) {
      return;
    }
    if (
      active.stopState ||
      active.retiring ||
      active.turn ||
      this.active.get(active.launchId) !== active
    ) {
      return;
    }
    const reason = frame.type === "idle-ready" ? "idle" : frame.retention;
    if (!reason) {
      return;
    }
    if (active.idleGeneration === undefined) {
      throw new Error("node worker reported unnegotiated retention");
    }
    clearNodeWorkerRetention(active);
    if (reason === "background") {
      active.retention = { reason, turnId: frame.turnId };
    } else {
      const timer = setTimeout(() => {
        if (active.retention?.reason === "idle" && active.retention.timer === timer) {
          void this.stopChild(active, "interrupted").catch(() => undefined);
        }
      }, 120_000);
      timer.unref();
      active.retention = { reason, turnId: frame.turnId, since: Date.now(), timer };
      if (this.closed || active.idleGeneration !== this.idleGeneration) {
        void this.stopChild(active, "interrupted").catch(() => undefined);
      } else if (this.idleChildren().length > 2) {
        void this.reclaimIdle().catch(() => undefined);
      }
    }
    this.publishIdle();
  }

  private async observeTerminalOutcome(
    active: NodeWorkerRunningChild,
    outcome: NodeWorkerTerminalOutcome,
  ): Promise<void> {
    const observed = createNodeWorkerObservedTerminal(active, outcome);
    if (this.active.get(active.launchId) !== active) {
      return;
    }
    this.active.set(active.launchId, observed);
    clearNodeWorkerRetention(active);
    if (active.idleGeneration !== undefined) {
      this.publishIdle();
    }
    try {
      await this.reconcileActiveTerminal(observed);
    } catch {
      // The observed outcome stays owned in memory for the next supervisor operation.
      return;
    }
    active.turn = undefined;
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

  private requireContainerLifecycle(): NodeWorkerContainerLifecycle {
    const lifecycle = this.containerLifecycle;
    if (!lifecycle) {
      throw new Error("node worker container isolation has no available engine");
    }
    return lifecycle;
  }

  private async cleanupChildContainer(active: NodeWorkerRunningChild): Promise<void> {
    if (!active.container) {
      return;
    }
    const cleanup = (active.containerCleanup ??= this.requireContainerLifecycle()
      .remove(active.container, active)
      .finally(() => {
        if (active.containerCleanup === cleanup) {
          active.containerCleanup = undefined;
        }
      }));
    await cleanup;
  }

  private async stopChild(
    active: NodeWorkerRunningChild,
    state?: NodeWorkerStopState,
  ): Promise<void> {
    const stopping = (async () => {
      active.retiring = true;
      if (active.retention?.reason === "idle") {
        clearTimeout(active.retention.timer);
      }
      active.stopState ??= state;
      if (active.container) {
        // The attach client owns no workload; fence the container and prove its
        // removal before its launch can become terminal or release capacity.
        await this.cleanupChildContainer(active);
      }
      active.adapter.kill("SIGTERM");
      const forceKill = setTimeout(() => active.adapter.kill("SIGKILL"), NODE_WORKER_STOP_GRACE_MS);
      forceKill.unref?.();
      try {
        await active.done;
      } finally {
        clearTimeout(forceKill);
      }
    })();
    if (active.idleGeneration !== undefined) {
      this.publishIdle();
    }
    await stopping.catch((error: unknown) => {
      if (active.retention?.reason === "idle" && !this.closed) {
        clearTimeout(active.retention.timer);
        active.retention.timer = setTimeout(() => {
          void this.stopChild(active, state).catch(() => undefined);
        }, 120_000).unref();
      }
      throw error;
    });
    await this.reconcileDeferredOutcome(active);
  }
}

export function createNodeWorkerSupervisor(
  options: NodeWorkerSupervisorOptions = {},
): NodeWorkerSupervisor {
  return new NodeWorkerSupervisor(options);
}
