import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type {
  NodeWorkerLaunchInput,
  NodeWorkerSupervisorIdentity,
} from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerProcessInput } from "../worker/worker-process-observation.js";
import {
  buildWorkerProcessTurn,
  type WorkerProcessMessage,
} from "../worker/worker-process-protocol.js";
import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import { nodeWorkerLaunchSecrets } from "./node-worker-child-secrets.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerLaunchClaim } from "./node-worker-journal.types.js";
import {
  observeNodeWorkerChild,
  type NodeWorkerTerminalOutcome,
} from "./node-worker-launch-observation.js";
import type { NodeWorkerCleanupMode } from "./node-worker-launch-receipt.js";
import type {
  NodeWorkerLaunchStore,
  NodeWorkerLaunchReceipt,
  NodeWorkerContainerIdentity,
} from "./node-worker-launch-store.js";
import {
  prepareNodeWorkerLaunchTransport,
  sendNodeWorkerInput,
  type NodeWorkerChildAdapter,
} from "./node-worker-launch-transport.js";
import {
  resolveNodeWorkerNativeInferenceWorkspace,
  type NodeWorkerNativeInferenceSnapshot,
} from "./node-worker-native-inference.js";
import {
  createNodeWorkerCredentialScrubber,
  sanitizeNodeWorkerDiagnostic,
} from "./node-worker-output.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { NodeWorkerProcessObservations } from "./node-worker-process-observation.js";
import {
  NODE_WORKER_STOP_GRACE_MS,
  NODE_WORKER_FORCE_STOP_WAIT_MS,
  clearNodeWorkerRetention,
  createNodeWorkerObservedTerminal,
  createNodeWorkerActiveTurn,
  nodeWorkerEnvironmentBinding,
  nodeWorkerReceiptMatchesOwner,
  type NodeWorkerActiveOwnership,
  type NodeWorkerRunningChild,
  type NodeWorkerStopState,
  type NodeWorkerPendingAdmission,
} from "./node-worker-supervisor-ownership.js";
import {
  createNodeWorkerTerminalReconciliation,
  type createNodeWorkerLaunchRecovery,
} from "./node-worker-supervisor-recovery.js";
import { stopOwnedNodeWorkerTree } from "./node-worker-tree-control.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

/** Owns physical children and their observed exit, turn settlement, and retained idle lifetime. */
export class NodeWorkerChildLifecycle {
  private readonly owners = new Map<string, NodeWorkerActiveOwnership>();
  readonly active: ReadonlyMap<string, NodeWorkerActiveOwnership> = this.owners;
  readonly reconcileActiveTerminal: ReturnType<typeof createNodeWorkerTerminalReconciliation>;
  private readonly processObservations = new NodeWorkerProcessObservations();

  observeProcesses(input: NodeWorkerProcessInput, signal?: AbortSignal) {
    const owner = [...this.owners.values()].find(
      (entry) =>
        entry.binding.environmentId === input.environmentId &&
        entry.binding.gatewayNamespace === input.gatewayNamespace,
    );
    if (!owner || owner.state !== "running" || this.options.isClosed()) {
      throw new Error(
        "Retained worker process observation unavailable; start a new turn and retry.",
      );
    }
    return this.processObservations.request(
      owner,
      input,
      () => !this.options.isClosed() && this.owners.get(owner.launchId) === owner,
      signal,
    );
  }

  constructor(
    private readonly options: {
      bundleRoot: string;
      nativeInferenceSnapshot?: NodeWorkerNativeInferenceSnapshot;
      engineEnv: NodeJS.ProcessEnv;
      store: NodeWorkerLaunchStore;
      turns: NodeWorkerTurnStore;
      capacity: NodeWorkerCapacity;
      containerEngine?: NodeWorkerContainerEngine;
      containerLifecycle?: NodeWorkerContainerLifecycle;
      containerImage?: string;
      starting: ReadonlyMap<string, Promise<NodeWorkerLaunchReceipt>>;
      initialize: () => Promise<void>;
      isClosed: () => boolean;
      cancelTurn: (
        expected: NodeWorkerSupervisorIdentity,
      ) => Promise<NodeWorkerLaunchReceipt | undefined>;
      recoverRunning: ReturnType<typeof createNodeWorkerLaunchRecovery>;
    },
  ) {
    this.reconcileActiveTerminal = createNodeWorkerTerminalReconciliation({
      active: this.owners,
      turns: options.turns,
      capacity: options.capacity,
    });
  }

  idleChildren(): NodeWorkerRunningChild[] {
    return [...this.owners.values()]
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
    this.options.capacity.setReclaimableIdle(this.idleChildren().length);
  }

  async reclaimIdle(): Promise<boolean> {
    const oldest = this.idleChildren()[0];
    if (!oldest) {
      return false;
    }
    await this.stopChild(oldest, "interrupted");
    return !this.owners.has(oldest.launchId);
  }

  async retireIdle(admissions: ReadonlyMap<string, NodeWorkerPendingAdmission>): Promise<void> {
    await Promise.allSettled([...admissions.values()].map((admission) => admission.done));
    const results = await Promise.allSettled(
      [...this.owners.values()].flatMap((owner) =>
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

  /** Starts one physical owner behind the durable journal gate, independent of turn reuse. */
  async startChild(params: {
    workerEnv: NodeJS.ProcessEnv;
    input: NodeWorkerLaunchInput;
    descriptor: WorkerLaunchDescriptor;
    supervisor: NodeWorkerProcessIdentity;
    claim: NodeWorkerLaunchClaim;
    signal?: AbortSignal;
    idleRetention?: boolean;
  }): Promise<NodeWorkerLaunchReceipt> {
    const sensitiveValues = nodeWorkerLaunchSecrets(
      params.descriptor,
      this.options.nativeInferenceSnapshot,
    );
    const scrubber = createNodeWorkerCredentialScrubber(sensitiveValues);
    // Turn cancellation can beat the child's admission retry deadline. Retain the
    // producer's latest cause so the durable terminal receipt does not become generic.
    const connectionFailure: { errorText?: string } = {};
    for (const value of sensitiveValues) {
      registerSecretValueForRedaction(value);
    }
    const finishFailed = (errorText: string) =>
      this.options.capacity.finish({
        launchId: params.input.launchId,
        planHash: params.claim.planHash,
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
        bundleRoot: this.options.bundleRoot,
        workerEnv: params.workerEnv,
        engineEnv: this.options.engineEnv,
        nativeInferenceSnapshot: this.options.nativeInferenceSnapshot,
        input: params.input,
        descriptor: params.descriptor,
        planHash: params.claim.planHash,
        supervisor: params.supervisor,
        connectionFailure,
        scrubber,
        store: this.options.store,
        containerEngine: this.options.containerEngine,
        containerLifecycle: this.options.containerLifecycle,
        containerImage: this.options.containerImage,
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
      idleRetention: params.idleRetention,
      adapter,
      journalReady,
      gatewayNamespace: params.input.gatewayNamespace,
      launchId: params.input.launchId,
      planHash: params.claim.planHash,
      scrubber,
      connectionFailure,
      supervisor: params.supervisor,
      worker,
      ...(container ? { container } : {}),
    } as NodeWorkerRunningChild; // SAFETY: done is assigned synchronously below; observation waits on journalReady before publishing state.
    active.done = this.observeChild(active);
    this.owners.set(active.launchId, active);
    void active.done.catch(() => undefined);
    let running: NodeWorkerLaunchReceipt;
    try {
      running = await this.options.store.markRunning({
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
        this.owners.delete(active.launchId);
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
      return (await this.options.store.get(active.launchId)) ?? running;
    }
    if (running.state !== "running") {
      if (container) {
        await this.stopChild(active, "interrupted");
      } else {
        adapter.closeStartGate?.();
      }
      return running;
    }
    if (this.options.isClosed() || params.signal?.aborted || active.turn?.cancelled) {
      await this.stopChild(active, this.options.isClosed() ? "interrupted" : "cancelled");
      return (await this.options.store.get(active.launchId)) ?? running;
    }
    try {
      const isCurrent = () =>
        this.owners.get(active.launchId) === active &&
        !this.options.isClosed() &&
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
        buildWorkerProcessTurn(params.descriptor, params.idleRetention === true),
      );
    } catch {
      // Only cancellation and shutdown override the child's observed exit.
      const stopState = this.options.isClosed()
        ? "interrupted"
        : params.signal?.aborted || active.turn?.cancelled
          ? "cancelled"
          : undefined;
      await this.stopChild(active, stopState);
      return (await this.options.store.get(active.launchId)) ?? running;
    }
    return (await this.options.turns.get(params.input.launchId)) ?? running;
  }

  async startTurn(
    active: NodeWorkerRunningChild,
    descriptor: WorkerLaunchDescriptor,
    claim: NodeWorkerLaunchClaim,
    signal: AbortSignal,
    idleRetention = false,
  ): Promise<NodeWorkerLaunchReceipt> {
    if (descriptor.assignment.inference === "runtime-local") {
      resolveNodeWorkerNativeInferenceWorkspace(this.options.nativeInferenceSnapshot, descriptor);
    }
    const isCurrent = () => this.owners.get(active.launchId) === active && !this.options.isClosed();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!isCurrent() || active.stopState || active.retiring || active.turn) {
        throw new Error("node worker turn lost its physical owner before admission");
      }
    };
    assertCurrent();
    const admitted = await this.options.turns.claim(
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
    const negotiated = active.idleRetention || idleRetention;
    active.idleRetention = idleRetention;
    if (negotiated) {
      this.publishIdle();
    }
    if (signal.aborted || !isCurrent() || active.stopState || active.retiring) {
      await this.stopChild(active, signal.aborted ? "cancelled" : "interrupted");
      return (await this.options.turns.get(claim.launchId)) ?? admitted.receipt;
    }
    const secrets = nodeWorkerLaunchSecrets(descriptor, this.options.nativeInferenceSnapshot);
    for (const value of secrets) {
      registerSecretValueForRedaction(value);
    }
    // The IPC diagnostic handler shares this object, so rotate its contents rather than its owner.
    Object.assign(active.scrubber, createNodeWorkerCredentialScrubber(secrets));
    active.connectionFailure.errorText = undefined;
    const onAbort = () => {
      void this.options.cancelTurn(claim).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await sendNodeWorkerInput(
        active.adapter,
        buildWorkerProcessTurn(descriptor, active.idleRetention),
      );
      if (signal.aborted) {
        await this.options.cancelTurn(claim);
      }
    } catch {
      await this.stopChild(active, "interrupted");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    return (await this.options.turns.get(claim.launchId)) ?? admitted.receipt;
  }

  async statusOwner(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined> {
    await this.options.initialize();
    const active = this.owners.get(launchId);
    if (active?.state === "observed") {
      return this.reconcileActiveTerminal(active);
    }
    if (active?.state === "running") {
      if (active.deferredOutcome && !active.container) {
        await this.reconcileDeferredOutcome(active);
        return this.options.store.get(launchId);
      }
      if (active.container) {
        const lifecycle = this.requireContainerLifecycle();
        const inspection = await lifecycle.inspect(active.container, active);
        if (inspection === "unknown") {
          return this.options.store.get(launchId);
        }
        if (inspection === "reused") {
          throw new Error(`node worker launch ${launchId} lost its container ownership`);
        }
        if (inspection === "live") {
          const clientState = inspectNodeWorkerProcessIdentity(active.worker);
          if (clientState !== "dead" && clientState !== "reused") {
            return this.options.store.get(launchId);
          }
          // Observe the dead attach client's result before fencing its still-running owner.
          await active.done;
          if (this.owners.get(launchId) === active) {
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
            NODE_WORKER_FORCE_STOP_WAIT_MS,
          );
          await active.done;
        }
      }
      const observed = this.owners.get(launchId);
      return observed?.state === "observed"
        ? this.reconcileActiveTerminal(observed)
        : this.options.store.get(launchId);
    }
    const receipt = await this.options.store.get(launchId);
    return receipt?.state === "running" ? await this.options.recoverRunning(receipt) : receipt;
  }

  async cancelOwner(
    expected: NodeWorkerSupervisorIdentity,
    awaitCleanup = false,
  ): Promise<NodeWorkerLaunchReceipt | undefined> {
    const receipt = await this.options.store.getMatching(expected);
    if (!receipt || (receipt.state !== "pending" && receipt.state !== "running")) {
      return receipt;
    }
    const active = this.owners.get(expected.launchId);
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
      const observed = this.owners.get(expected.launchId);
      if (observed?.state === "observed") {
        return this.reconcileActiveTerminal(observed);
      }
      return this.options.store.getMatching(expected);
    }
    const startup = this.options.starting.get(expected.launchId);
    if (startup && receipt.supervisor.pid === process.pid) {
      if (receipt.container || (receipt.state === "pending" && this.options.containerEngine)) {
        // Startup may already own a container while its create/start client is
        // in flight; retain the durable slot until normal cancellation fences it.
        await startup;
        return await this.cancelOwner(expected, awaitCleanup);
      }
      if (receipt.state === "pending") {
        const cancelled = await this.options.capacity.finishCancelled({
          expected,
          supervisor: receipt.supervisor,
          worker: null,
        });
        await startup;
        return (await this.options.store.getMatching(expected)) ?? cancelled;
      }
    }
    return await this.options.recoverRunning(receipt, true, "cancelled", awaitCleanup);
  }

  private async observeChild(active: NodeWorkerRunningChild): Promise<void> {
    const observation = await observeNodeWorkerChild(
      active,
      (frame) => this.settleTurn(active, frame),
      () => active.turn?.claim.launchId,
      active.container ? () => this.cleanupChildContainer(active) : undefined,
    ).finally(() => this.processObservations.retire(active));
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
    if (frame.type === "process-result") {
      this.processObservations.accept(active, frame);
      return;
    }
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
          const receipt = await this.options.turns.finish({
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
      this.owners.get(active.launchId) !== active
    ) {
      return;
    }
    const reason = frame.type === "idle-ready" ? "idle" : frame.retention;
    if (!reason) {
      return;
    }
    if (!active.idleRetention) {
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
      if (this.options.isClosed()) {
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
    if (this.owners.get(active.launchId) !== active) {
      return;
    }
    this.owners.set(active.launchId, observed);
    clearNodeWorkerRetention(active);
    if (active.idleRetention) {
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
    const lifecycle = this.options.containerLifecycle;
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
        active.containerCleanup = undefined;
      }));
    await cleanup;
  }

  async stopChild(active: NodeWorkerRunningChild, state?: NodeWorkerStopState): Promise<void> {
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
    if (active.idleRetention) {
      this.publishIdle();
    }
    await stopping.catch((error: unknown) => {
      if (active.retention?.reason === "idle" && !this.options.isClosed()) {
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
