import { addAbortListener } from "node:events";
import path from "node:path";
import { NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { resolveStateDir } from "../config/paths.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withTimeout } from "../infra/fs-safe.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
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
import {
  parseWorkerConnectionEndpoint,
  type WorkerConnectionEndpoint,
} from "../worker/worker-connection-endpoint.js";
import type { NodeWorkerProcessInput } from "../worker/worker-process-observation.js";
import { throwNodeHostCleanupErrors } from "./cleanup-errors.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import { NodeWorkerChildLifecycle } from "./node-worker-child-lifecycle.js";
import { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import type { NodeWorkerLaunchClaim } from "./node-worker-journal.types.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import { sendNodeWorkerInput } from "./node-worker-launch-transport.js";
import {
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  NODE_WORKER_STOP_GRACE_MS,
  NODE_WORKER_FORCE_STOP_WAIT_MS,
  nodeWorkerEnvironmentBinding,
  nodeWorkerEnvironmentKey,
  nodeWorkerEnvironmentMatches,
  type NodeWorkerPendingAdmission,
  type NodeWorkerRunningChild,
  type NodeWorkerSupervisorOptions,
} from "./node-worker-supervisor-ownership.js";
import {
  createNodeWorkerLaunchRecovery,
  type NodeWorkerRecovery,
} from "./node-worker-supervisor-recovery.js";
import { NodeWorkerTurnStore, type NodeWorkerTurnReceipt } from "./node-worker-turn-store.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

/** Coordinates turn admission, cancellation, workspace custody, and journal shutdown. */
class NodeWorkerSupervisor {
  private readonly children: NodeWorkerChildLifecycle;
  private readonly starting = new Map<string, Promise<NodeWorkerLaunchReceipt>>();
  private readonly recoveries = new Map<string, NodeWorkerRecovery>();
  private readonly recoverRunning: ReturnType<typeof createNodeWorkerLaunchRecovery>;
  private readonly journal: NodeWorkerJournalWorker;
  private readonly store: NodeWorkerLaunchStore;
  private readonly turns: NodeWorkerTurnStore;
  private readonly admissions = new Map<string, NodeWorkerPendingAdmission>();
  private readonly retentions = new Set<Promise<NodeWorkerWorkspaceRetainResult>>();
  private readonly workerEnv: NodeJS.ProcessEnv;
  private readonly capacity: NodeWorkerCapacity;
  private readonly workspace: NodeWorkerWorkspaceRuntime;
  private readonly containerLifecycle?: NodeWorkerContainerLifecycle;
  private supervisorIdentity?: NodeWorkerProcessIdentity;
  private initializationPromise?: Promise<void>;
  private closed = false;
  private closeCompleted = false;
  private closePromise?: Promise<void>;

  constructor(options: NodeWorkerSupervisorOptions = {}) {
    const env = options.env ?? process.env;
    const startup = {
      nativeInferenceSnapshot: options.nativeInferenceSnapshot,
      workerEnv: snapshotNodeWorkerEnv(env),
      engineEnv: { ...process.env, ...env },
    };
    const bundleRoot = path.resolve(
      options.bundleRoot ?? path.join(resolveStateDir(env), "node-host"),
    );
    this.journal = new NodeWorkerJournalWorker({ env });
    this.store = new NodeWorkerLaunchStore(this.journal);
    this.turns = new NodeWorkerTurnStore(this.journal);
    this.workerEnv = startup.workerEnv;
    const containerEngine = options.containerEngine;
    this.containerLifecycle = options.containerEngine
      ? new NodeWorkerContainerLifecycle(options.containerEngine, bundleRoot, this.store)
      : undefined;
    const containerImage = options.containerImage;
    this.workspace =
      options.workspace ??
      new NodeWorkerWorkspaceRuntime({ root: bundleRoot, env: this.workerEnv });
    this.capacity = new NodeWorkerCapacity(this.store, options);
    this.recoverRunning = createNodeWorkerLaunchRecovery({
      store: this.store,
      capacity: this.capacity,
      containerLifecycle: this.containerLifecycle,
      recoveries: this.recoveries,
      isRecoveryActive: () => !this.closed,
    });
    this.children = new NodeWorkerChildLifecycle({
      bundleRoot,
      ...startup,
      store: this.store,
      turns: this.turns,
      capacity: this.capacity,
      containerEngine,
      containerLifecycle: this.containerLifecycle,
      containerImage,
      starting: this.starting,
      initialize: () => this.initialize(),
      isClosed: () => this.closed,
      cancelTurn: (expected) => this.cancelTurn(expected),
      recoverRunning: this.recoverRunning,
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
      this.initializationPromise = undefined;
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
      this.children.active.size > this.children.idleChildren().length ||
      this.workspace.processes.hasActiveWork() ||
      this.workspace.quiescence.hasActiveWork();
    if (hasLocalWork()) {
      return true;
    }
    const count = await this.store.nonterminalCount();
    return count > this.children.idleChildren().length || hasLocalWork();
  }

  retireIdle(): Promise<void> {
    return this.children.retireIdle(this.admissions);
  }

  async launch(
    rawInput: NodeWorkerLaunchInput,
    connectionEndpoint: WorkerConnectionEndpoint,
    signal?: AbortSignal,
  ): Promise<NodeWorkerLaunchReceipt> {
    const input = validateNodeWorkerLaunchInput(structuredClone(rawInput));
    const parsedEndpoint = parseWorkerConnectionEndpoint(connectionEndpoint);
    if (!parsedEndpoint) {
      throw new Error("invalid worker launch descriptor");
    }
    const descriptor = { ...input.descriptor, connectionEndpoint: parsedEndpoint };
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
    const assertEnvironmentCurrent = this.workspace.processes.captureAdmission(
      binding,
      binding.ownerEpoch,
    );
    assertEnvironmentCurrent();
    const admission = this.admissions.get(key);
    if (admission) {
      const { launchId, planHash } = admission.identity;
      if (launchId !== input.launchId || planHash !== claimInput.planHash) {
        throw new Error("node worker environment already has a turn being admitted");
      }
      return await admission.done;
    }
    const abort = new AbortController();
    const idleRetention =
      input.idleRetention &&
      descriptor.admission.handshake.protocolFeatures.includes(
        NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
      );
    const admissionSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const done = (async () => {
      const workspace = await this.workspace.acquirePreparedWorkspace({
        ...binding,
        sessionKey: input.sessionKey,
      });
      try {
        admissionSignal.throwIfAborted();
        if (this.closed) {
          throw new Error("node worker supervisor is closed");
        }
        assertEnvironmentCurrent();
        return await this.launchAdmitted(
          input,
          descriptor,
          claimInput,
          admissionSignal,
          workspace?.homeDir,
          idleRetention,
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
      this.admissions.delete(key);
    }
  }

  private async launchAdmitted(
    input: NodeWorkerLaunchInput,
    descriptor: WorkerLaunchDescriptor,
    claimInput: NodeWorkerLaunchClaim,
    signal: AbortSignal,
    homeDir?: string,
    idleRetention?: boolean,
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
    for (const owner of this.children.active.values()) {
      if (nodeWorkerEnvironmentKey(owner.binding) !== nodeWorkerEnvironmentKey(binding)) {
        continue;
      }
      if (owner.state === "observed") {
        await this.children.reconcileActiveTerminal(owner);
        continue;
      }
      await this.children.statusOwner(owner.launchId);
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
      if (this.children.active.get(owner.launchId) !== owner) {
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
        await this.children.stopChild(owner, "interrupted");
        if (this.children.active.get(owner.launchId) === owner) {
          throw new Error("node worker environment cleanup is incomplete");
        }
        signal.throwIfAborted();
        continue;
      }
      return await this.children.startTurn(owner, descriptor, claimInput, signal, idleRetention);
    }
    const claim = await this.capacity.claim(claimInput, supervisor, signal, () =>
      this.children.reclaimIdle(),
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
    const startup = this.children.startChild({
      workerEnv: homeDir ? snapshotNodeWorkerEnv(this.workerEnv, homeDir) : this.workerEnv,
      input,
      descriptor,
      supervisor,
      signal,
      claim: claimInput,
      idleRetention,
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
      this.starting.delete(input.launchId);
    }
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
        const turn: NodeWorkerRunningChild["turn"] = this.children.active.get(
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
    const owner = turn && this.children.active.get(turn.ownerLaunchId);
    if (
      turn &&
      !this.closeCompleted &&
      (!owner ||
        owner.state === "observed" ||
        (owner.state === "running" && owner.deferredOutcome) ||
        turn.state === "pending" ||
        turn.state === "running")
    ) {
      await this.children.statusOwner(turn.ownerLaunchId);
    }
    return turn ? this.turns.get(launchId) : undefined;
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

  observeProcesses(input: NodeWorkerProcessInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.workspace.processes.captureAdmission(input, input.ownerEpoch)();
    return this.children.observeProcesses(input, signal);
  }

  async stopEnvironment(expected: NodeWorkerEnvironmentStopInput): Promise<void> {
    const key = nodeWorkerEnvironmentKey(expected);
    const errors: unknown[] = [];
    const admission = this.admissions.get(key);
    const matchingAdmission =
      admission && nodeWorkerEnvironmentMatches(admission.binding, expected)
        ? admission
        : undefined;
    matchingAdmission?.abort.abort(new Error("node worker environment stopped"));
    return await this.workspace.processes.stopEnvironment(expected, async () => {
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
          const active = this.children.active.get(owner.launchId);
          if (active && nodeWorkerEnvironmentMatches(active.binding, expected)) {
            return;
          }
          await this.children.cancelOwner(owner, true);
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
      for (const owner of this.children.active.values()) {
        if (!nodeWorkerEnvironmentMatches(owner.binding, expected)) {
          continue;
        }
        try {
          if (owner.state === "running") {
            await this.children.stopChild(owner, "interrupted");
          }
          const observed = this.children.active.get(owner.launchId);
          if (observed?.state === "observed") {
            await this.children.reconcileActiveTerminal(observed);
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
      throwNodeHostCleanupErrors(errors, "node worker environment cleanup failed");
    });
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
    for (const owner of this.children.active.values()) {
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
      (this.children.active.get(matched.owner.launchId) !== matched.owner ||
        matched.owner.turn !== matched.turn)
    ) {
      return this.status(expected.launchId);
    }
    const active = this.children.active.get(receipt.ownerLaunchId);
    if (active?.state !== "running" || active.turn?.claim.launchId !== expected.launchId) {
      const owner = await this.store.get(receipt.ownerLaunchId);
      if (owner) {
        await this.children.cancelOwner(owner);
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
        NODE_WORKER_STOP_GRACE_MS + NODE_WORKER_FORCE_STOP_WAIT_MS,
        { message: "node worker turn cancellation did not settle" },
      );
    } catch {
      if (this.children.active.get(active.launchId) === active && active.turn === turn) {
        await this.children.stopChild(active, "cancelled");
      }
    }
    if (this.children.active.get(active.launchId)?.state === "observed") {
      return this.status(expected.launchId);
    }
    return this.turns.getMatching(expected);
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
      this.closePromise = undefined;
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
      ...[...this.children.active.values()]
        .filter((active): active is NodeWorkerRunningChild => active.state === "running")
        .map((active) => this.children.stopChild(active, "interrupted")),
    ]);
    errors.push(
      ...stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    for (const active of this.children.active.values()) {
      if (active.state !== "observed") {
        continue;
      }
      try {
        await this.children.reconcileActiveTerminal(active);
      } catch (error) {
        errors.push(error);
      }
    }
    await this.journal
      .drain({ close: errors.length === 0 })
      .catch((error: unknown) => errors.push(error));
    throwNodeHostCleanupErrors(errors, "node worker terminal reconciliation failed");
  }
}

export function createNodeWorkerSupervisor(
  options: NodeWorkerSupervisorOptions = {},
): NodeWorkerSupervisor {
  return new NodeWorkerSupervisor(options);
}
