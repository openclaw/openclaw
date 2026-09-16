import { addAbortListener } from "node:events";
import { withTimeout } from "../infra/fs-safe.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import {
  buildWorkerProcessTurn,
  type WorkerProcessResult,
} from "../worker/worker-process-protocol.js";
import { nodeWorkerTurnMatchesIdentity } from "./node-worker-journal.types.js";
import type {
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchReceipt,
  NodeWorkerLaunchStore,
} from "./node-worker-launch-store.js";
import { sendNodeWorkerInput } from "./node-worker-launch-transport.js";
import { createNodeWorkerCredentialScrubber } from "./node-worker-output.js";
import type { NodeWorkerSupervisorIdentity } from "./node-worker-supervisor-contract.js";
import {
  createNodeWorkerActiveTurn,
  type NodeWorkerActiveOwnership,
  type NodeWorkerObservedTerminal,
  type NodeWorkerRunningChild,
  type NodeWorkerStopState,
} from "./node-worker-supervisor-ownership.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

/** Shutdown must be able to abort admission before it stops the retiring physical owner. */
export async function waitForNodeWorkerRetirement(
  active: NodeWorkerRunningChild,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!active.retiring) {
    return;
  }
  const aborted = createDeferredCore();
  const listener = addAbortListener(signal, () => aborted.resolve());
  try {
    await Promise.race([active.done, aborted.promise]);
  } finally {
    listener[Symbol.dispose]();
  }
}

export function nodeWorkerDescriptorSecrets(descriptor: WorkerLaunchDescriptor): string[] {
  const endpoint = descriptor.connectionEndpoint;
  const access = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
  return [
    descriptor.admission.credential,
    ...(access ? [access.clientId, access.clientSecret] : []),
    ...(descriptor.assignment.github ? [descriptor.assignment.github.token] : []),
  ];
}

/** Persist completion before releasing the turn; the physical launch still owns cleanup. */
export async function settleNodeWorkerTurn(
  active: NodeWorkerRunningChild,
  frame: WorkerProcessResult,
  store: NodeWorkerTurnStore,
): Promise<void> {
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
      const receipt = await store.finish({
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
}

/** Preserve accepted cancellation when a worker exits without a turn result frame. */
export async function reconcileNodeWorkerTurnCancellation(
  active: NodeWorkerObservedTerminal,
  store: NodeWorkerTurnStore,
): Promise<void> {
  if (!active.cancelledTurn) {
    return;
  }
  // Gateway authority may close before worker finishing. The physical failure
  // remains separate, and neither journal can settle before process cleanup.
  const turn = await store.finish({
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

export async function startNodeWorkerTurn({
  active,
  descriptor,
  claim,
  signal,
  store,
  cancel,
  stopChild,
  isCurrent,
}: {
  active: NodeWorkerRunningChild;
  descriptor: WorkerLaunchDescriptor;
  claim: NodeWorkerLaunchClaim;
  signal: AbortSignal;
  store: NodeWorkerTurnStore;
  cancel: (expected: NodeWorkerSupervisorIdentity) => Promise<NodeWorkerLaunchReceipt | undefined>;
  stopChild: (active: NodeWorkerRunningChild, state: NodeWorkerStopState) => Promise<void>;
  isCurrent: () => boolean;
}): Promise<NodeWorkerLaunchReceipt> {
  signal.throwIfAborted();
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!isCurrent() || active.stopState || active.retiring || active.turn) {
      throw new Error("node worker turn lost its physical owner before admission");
    }
  };
  assertCurrent();
  const admitted = await store.claim(
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
  active.turn = createNodeWorkerActiveTurn(claim);
  if (signal.aborted || !isCurrent() || active.stopState || active.retiring) {
    await stopChild(active, signal.aborted ? "cancelled" : "interrupted");
    return (await store.get(claim.launchId)) ?? admitted.receipt;
  }
  const secrets = nodeWorkerDescriptorSecrets(descriptor);
  for (const value of secrets) {
    registerSecretValueForRedaction(value);
  }
  // The IPC diagnostic handler shares this object, so rotate its contents rather than its owner.
  Object.assign(active.scrubber, createNodeWorkerCredentialScrubber(secrets));
  active.connectionFailure.errorText = undefined;
  const onAbort = () => {
    void cancel(claim).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await sendNodeWorkerInput(active.adapter, buildWorkerProcessTurn(descriptor));
    if (signal.aborted) {
      await cancel(claim);
    }
  } catch {
    await stopChild(active, "interrupted");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return (await store.get(claim.launchId)) ?? admitted.receipt;
}

type NodeWorkerTurnCancellationContext = {
  admissions: ReadonlyMap<
    string,
    { identity: NodeWorkerSupervisorIdentity; abort: AbortController }
  >;
  active: ReadonlyMap<string, NodeWorkerActiveOwnership>;
  turns: Pick<NodeWorkerTurnStore, "getMatching">;
  launches: Pick<NodeWorkerLaunchStore, "get">;
  stopTimeoutMs: number;
  initialize(): Promise<void>;
  status(launchId: string): Promise<NodeWorkerLaunchReceipt | undefined>;
  cancelOwner(expected: NodeWorkerSupervisorIdentity): Promise<NodeWorkerLaunchReceipt | undefined>;
  stopChild(active: NodeWorkerRunningChild, state: NodeWorkerStopState): Promise<void>;
};

/** Cancel one logical turn; physical cleanup remains with its supervisor owner. */
export async function cancelNodeWorkerTurn(
  context: NodeWorkerTurnCancellationContext,
  expected: NodeWorkerSupervisorIdentity,
): Promise<NodeWorkerLaunchReceipt | undefined> {
  const afterSettlement = async (settling: Promise<void>) => {
    try {
      await settling;
    } catch {
      return await cancelNodeWorkerTurn(context, expected);
    }
    return context.turns.getMatching(expected);
  };
  let settling: Promise<void> | undefined;
  let matched:
    | {
        owner: NodeWorkerRunningChild;
        turn: NonNullable<NodeWorkerRunningChild["turn"]>;
      }
    | undefined;
  for (const admission of context.admissions.values()) {
    if (nodeWorkerTurnMatchesIdentity(admission.identity, expected)) {
      admission.abort.abort(new Error("node worker turn cancelled"));
    }
  }
  for (const owner of context.active.values()) {
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
  await context.initialize();
  const receipt = await context.turns.getMatching(expected);
  if (!receipt || (receipt.state !== "pending" && receipt.state !== "running")) {
    return receipt ? await context.status(receipt.launchId) : undefined;
  }
  if (matched?.turn.settling) {
    return await afterSettlement(matched.turn.settling);
  }
  if (
    matched &&
    (context.active.get(matched.owner.launchId) !== matched.owner ||
      matched.owner.turn !== matched.turn)
  ) {
    return context.status(expected.launchId);
  }
  const active = context.active.get(receipt.ownerLaunchId);
  if (active?.state !== "running" || active.turn?.claim.launchId !== expected.launchId) {
    const owner = await context.launches.get(receipt.ownerLaunchId);
    if (owner) {
      await context.cancelOwner(owner);
    }
    return context.turns.getMatching(expected);
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
      context.stopTimeoutMs,
      { message: "node worker turn cancellation did not settle" },
    );
  } catch {
    if (context.active.get(active.launchId) === active && active.turn === turn) {
      await context.stopChild(active, "cancelled");
    }
  }
  if (context.active.get(active.launchId)?.state === "observed") {
    return context.status(expected.launchId);
  }
  return context.turns.getMatching(expected);
}
