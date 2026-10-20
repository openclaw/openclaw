/** Mailbox identity, source reservations and native producer admission. */
import { randomUUID } from "node:crypto";
import type { FollowupRun, QueueSettings } from "../auto-reply/reply/queue/types.js";
import {
  resolveExplicitSessionStorePathForScope,
  resolveSessionStorePathCore,
} from "../config/sessions/paths.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  inputCancellation,
  type SessionControllerInput,
  type SessionControllerMailboxClaim,
  type SessionControllerMailbox,
  type SessionControllerSourceAdapter,
} from "./session-controller.contracts.js";
import { logSessionControllerSourceClaim } from "./session-controller.diagnostics.js";
import { bindSessionControllerMailboxRestartDrain } from "./session-controller.mailbox-cleanup.js";
import { pumpSessionControllerMailbox } from "./session-controller.mailbox-dispatch.js";
import {
  bindSessionControllerSource,
  retireSessionControllerInput,
} from "./session-controller.mailbox-source.js";
import {
  claimSessionControllerTask,
  tryClaimSessionControllerTask,
} from "./session-controller.mailbox-task.js";
import { ownerContext } from "./session-controller.owner-context.js";
import {
  getSessionControllerEntry,
  findSessionControllerEntries,
  findSessionControllerEntry,
  sessionControllers,
} from "./session-controller.state.js";
import { captureSessionTarget, type SessionTarget } from "./session-controller.target.js";

export {
  bindSessionControllerInputOperation,
  attachSessionControllerInputOperation,
  releaseSessionControllerClaim,
} from "./session-controller.mailbox-claim.js";
export type {
  SessionControllerInput,
  SessionControllerMailboxClaim,
  SessionControllerMailbox,
  SessionControllerSourceAdapter,
} from "./session-controller.contracts.js";
export {
  bindSessionControllerSource,
  isSessionControllerSourceQueued,
  beginSessionControllerSourceInjection,
  retireSessionControllerSourceCancellation,
  updateSessionControllerSourcePolicy,
  trackSessionControllerSourceWork,
  retireSessionControllerInput,
  abortSessionControllerInput,
  captureSessionControllerSourceSettlement,
  holdSessionControllerSourceWithdrawal,
} from "./session-controller.mailbox-source.js";
export { clearSessionControllerMailbox } from "./session-controller.mailbox-cleanup.js";

export function getSessionControllerMailbox(
  key: string,
  target?: SessionTarget,
): SessionControllerMailbox {
  const owner = getSessionControllerEntry(key, target);
  if (owner.mailbox) {
    return owner.mailbox;
  }
  const mailbox: SessionControllerMailbox = {
    key: owner.key,
    owner,
    nextSequence: 0,
    entries: [],
    wake: () => pumpSessionControllerMailbox(mailbox),
    abortController: new AbortController(),
    get items() {
      return mailbox.entries.flatMap((input) =>
        input.payload === "ready" &&
        input.phase !== "consumed" &&
        !input.retirementRequested &&
        input.source
          ? [input.source]
          : [],
      );
    },
    get draining() {
      return Boolean(mailbox.claim);
    },
    get inFlight() {
      return new Set(mailbox.claim?.sources ?? []);
    },
    lastEnqueuedAt: 0,
    mode: "followup",
    debounceMs: 500,
    cap: 20,
    dropPolicy: "summarize",
    droppedCount: 0,
    summaryLines: [],
    summarySources: [],
    activeSummarySources: new Set(),
    summaryElisions: [],
    recentSources: new Map(),
  };
  owner.mailbox = mailbox;
  return mailbox;
}

export function getExistingSessionControllerMailbox(key: string, target?: SessionTarget) {
  const matches = findSessionControllerEntries(key.trim(), target).flatMap((entry) =>
    entry.mailbox ? [entry.mailbox] : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function* sessionControllerMailboxes() {
  for (const owner of sessionControllers.values()) {
    if (owner.mailbox) {
      yield owner.mailbox;
    }
  }
}

const queueSettingKeys = ["mode", "debounceMs", "cap", "dropPolicy"] as const;
const sameQueueSettings = (a: QueueSettings, b: QueueSettings) =>
  queueSettingKeys.every((key) => a[key] === b[key]);
const isUnboundPreparingSource = (input: SessionControllerInput) =>
  input.phase === "preparing" &&
  !input.claim &&
  !input.injection &&
  !input.source &&
  !input.task &&
  !input.ready &&
  !input.retirementRequested &&
  !input.withdrawalHolds &&
  !input.custody.enqueued;

export function claimSessionControllerInput(
  source: FollowupRun,
): Promise<SessionControllerMailboxClaim> {
  const input =
    source.controllerInput ??
    submitSessionControllerInput(source.run.sessionKey ?? source.run.sessionId, source, {
      mode: "followup",
    });
  if (input.claim && !input.claim.released) {
    return Promise.resolve(input.claim);
  }
  if (input.injection) {
    return Promise.reject(new Error("Source injection outcome pending"));
  }
  if (input.phase === "consumed" || input.retirementRequested) {
    return Promise.reject(new Error("Input already consumed"));
  }
  const pending = createDeferredCore<SessionControllerMailboxClaim>();
  const signals = [
    input.abortSignal,
    source.abortSignal,
    source.queueAbortSignal,
    source.operatorAuthority?.signal,
    input.sourceAdapter?.signal,
    input.sourceAdapter?.authority?.signal,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const abort = () => retireSessionControllerInput(input);
  input.ready = (claim) => {
    signal?.removeEventListener("abort", abort);
    pending.resolve(claim);
  };
  input.reject = (error) => {
    signal?.removeEventListener("abort", abort);
    logSessionControllerSourceClaim(input, "failed");
    pending.reject(error);
  };
  if (signal?.aborted) {
    abort();
    return pending.promise;
  }
  signal?.addEventListener("abort", abort, { once: true });
  input.phase = "waiting";
  logSessionControllerSourceClaim(input, "waiting");
  input.mailbox.wake();
  return pending.promise;
}

export function detachSessionControllerSources(sources: readonly FollowupRun[]): void {
  for (const source of sources) {
    if (source.controllerInput) {
      source.controllerInput.payload = "unbound";
    }
  }
}

/** Native producer admission enters the same sequence, not a parallel runnable list. */
export function submitSessionControllerTask(
  key: string,
  params: {
    signal?: AbortSignal;
    target?: SessionTarget;
    onCancelled?: (reason?: unknown) => void;
    onSettled?: () => Promise<void>;
    start(claim: SessionControllerMailboxClaim): void;
  },
): Promise<SessionControllerMailboxClaim> {
  const input = reserveSessionControllerSource(key, {
    policy: { mode: "followup" },
    target: params.target,
    adapter: {
      signal: params.signal,
      cancel: params.onCancelled,
      onSettled: params.onSettled,
    },
  });
  // A task submitted by a mutation body for its own session is that mutation's turn.
  input.mutation = [...(ownerContext.getStore()?.mutations ?? [])].find(
    (mutation) => mutation.phase === "active" && mutation.entries.includes(input.mailbox.owner),
  );
  return claimSessionControllerTask(input, (claim) => params.start(claim));
}

export { claimSessionControllerTask, tryClaimSessionControllerTask };

type SessionControllerSourceReservation = {
  sourceTurnId?: string;
  protocolRunId?: string;
  sourceSessionId?: string;
  reservationId?: string;
  /** Restart recovery may retire an unclaimed reservation bound to an older target. */
  replaceInactiveTarget?: boolean;
  continuationCaller?: SessionControllerInput["continuationCaller"];
  policy: QueueSettings;
  adapter?: SessionControllerSourceAdapter;
  target?: SessionTarget;
  /** Runs when the mailbox claims a newly created input; it owns and must release that claim. */
  start?: (claim: SessionControllerMailboxClaim) => void;
};

/** Reserves identity/custody before attachment or prompt preparation, without owning a turn. */
export function reserveSessionControllerSource(
  key: string,
  params: SessionControllerSourceReservation,
): SessionControllerInput {
  return reserveOrJoinSessionControllerSource(key, params).input;
}

/** Reserves an input or joins the live one with the same reservationId; only the creator may retire it. */
export function reserveOrJoinSessionControllerSource(
  key: string,
  params: SessionControllerSourceReservation,
): { input: SessionControllerInput; created: boolean } {
  const target =
    params.target ??
    (params.adapter?.scope
      ? captureSessionTarget({ storeScope: params.adapter.scope, sessionKey: key })
      : undefined);
  const reservationId = params.reservationId?.trim();
  if (reservationId) {
    const existing = Array.from(sessionControllerMailboxes())
      .flatMap((mailbox) => mailbox.entries)
      .find(
        (input) =>
          input.sourceTurnId === reservationId &&
          input.phase !== "consumed" &&
          !input.retirementRequested,
      );
    if (existing) {
      const targetChanged =
        target !== undefined &&
        existing.mailbox.owner !== findSessionControllerEntry(target.sessionKey, target);
      if (
        (existing.protocolRunId !== undefined &&
          params.protocolRunId !== undefined &&
          existing.protocolRunId !== params.protocolRunId) ||
        !sameQueueSettings(existing.policy, params.policy) ||
        (targetChanged && (!params.replaceInactiveTarget || !isUnboundPreparingSource(existing)))
      ) {
        throw new Error("Reserved source identity belongs to a different delivery");
      }
      if (!targetChanged) {
        return { input: existing, created: false };
      }
      retireSessionControllerInput(existing);
    }
  }
  bindSessionControllerMailboxRestartDrain();
  const mailbox = getSessionControllerMailbox(key, target);
  const cancellation = new AbortController();
  const injectionOrder = createDeferredCore<boolean>();
  let injectionOrderResolved = false;
  const signals = [
    cancellation.signal,
    params.adapter?.signal,
    params.adapter?.authority?.signal,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  const input: SessionControllerInput = {
    [inputCancellation]: cancellation,
    abortSignal: signals.length > 1 ? AbortSignal.any(signals) : cancellation.signal,
    instance: Object.freeze({ id: randomUUID() }),
    sequence: ++mailbox.nextSequence,
    sourceTurnId: reservationId ?? params.sourceTurnId,
    protocolRunId: params.protocolRunId,
    sourceSessionId: params.sourceSessionId,
    policy: Object.freeze({ ...params.policy }),
    mailbox,
    sourceAdapter: params.adapter,
    target: target ?? mailbox.owner.target,
    continuationCaller: params.continuationCaller,
    custody: {},
    settlement: createDeferredCore(),
    injectionOrder: {
      get resolved() {
        return injectionOrderResolved;
      },
      settled: injectionOrder.promise,
      settle(consumed) {
        injectionOrderResolved = true;
        injectionOrder.resolve(consumed);
      },
    },
    phase: "preparing",
    withdrawalHolds: 0,
    payload: "unbound",
  };
  bindGatewayContextResolver(input, getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext);
  mailbox.entries.push(input);
  notifyGatewayWorkMetricsChanged();
  if (params.policy.mode === "interrupt") {
    mailbox.priority = input;
  }
  const signal = input.abortSignal;
  const abort = () => {
    if (input.custody.cancellationRetired) {
      return;
    }
    if (input.claim && !input.claim.released) {
      input.claim.abortController.abort(signal.reason);
    }
    retireSessionControllerInput(input);
  };
  input.custody.disposeSource = () => signal.removeEventListener("abort", abort);
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  if (params.start) {
    // Retirement before the claim settles custody; the rejected claim request has no other observer.
    void claimSessionControllerTask(input, params.start).catch(() => {});
  }
  return { input, created: true };
}

/** Transfers one unclaimed in-process reservation into its Gateway turn owner. */
export function adoptSessionControllerSource(
  input: SessionControllerInput,
  params: {
    protocolRunId: string;
    target: SessionTarget;
    policy: QueueSettings;
    adapter: SessionControllerSourceAdapter;
  },
): void {
  const assertAdoptable = () => {
    if (
      (input.protocolRunId !== undefined && input.protocolRunId !== params.protocolRunId) ||
      !sameQueueSettings(input.policy, params.policy) ||
      input.mailbox.owner !== findSessionControllerEntry(params.target.sessionKey, params.target) ||
      input.mailbox.owner.mailbox !== input.mailbox ||
      !input.mailbox.entries.includes(input) ||
      !isUnboundPreparingSource(input) ||
      input.custody.rpcAdopted
    ) {
      throw new Error("Cannot adopt a foreign or claimed session controller source");
    }
    input.abortSignal.throwIfAborted();
  };
  assertAdoptable();
  params.adapter.authority?.assertCurrent();
  assertAdoptable();
  input.target = params.target;
  input.protocolRunId = params.protocolRunId;
  input.sourceAdapter = params.adapter;
  input.custody.rpcAdopted = true;
  // Adoption keeps the original input signal stable for existing observers.
  // Forward the new source lifetime into that same cancellation owner.
  const signals = [params.adapter.signal, params.adapter.authority?.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  const dispose = input.custody.disposeSource;
  const listeners = signals.map((signal) => {
    const abort = () => input[inputCancellation].abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    return { signal, abort };
  });
  input.custody.disposeSource = () => {
    dispose?.();
    for (const { signal, abort } of listeners) {
      signal.removeEventListener("abort", abort);
    }
  };
  for (const { signal, abort } of listeners) {
    if (signal.aborted) {
      abort();
      break;
    }
  }
}

function resolveSourceTarget(key: string, source: FollowupRun, storePath?: string): SessionTarget {
  return captureSessionTarget({
    storeScope:
      storePath ??
      resolveExplicitSessionStorePathForScope({ agentId: source.run.agentId, sessionKey: key }) ??
      resolveSessionStorePathCore(source.run.config.session?.store, {
        agentId: source.run.agentId,
      }),
    sessionKey: key,
    agentId: source.run.agentId,
    incarnation: source.run.sessionId,
  });
}

/** Read source-scoped history without creating a mailbox for a rejected redelivery. */
export function findSessionControllerSourceMailbox(
  key: string,
  source: FollowupRun,
  storePath?: string,
) {
  return (
    source.controllerInput?.mailbox ??
    getExistingSessionControllerMailbox(key, resolveSourceTarget(key, source, storePath))
  );
}

/** Capture source identity synchronously, before configuration reads or custody callbacks. */
export function submitSessionControllerInput(
  key: string,
  source: FollowupRun,
  policy: QueueSettings,
  options?: { protocolRunId?: string; storePath?: string },
): SessionControllerInput {
  if (source.controllerInput) {
    if (!source.controllerInput.mailbox.owner.aliases.has(key.trim())) {
      throw new Error("Source belongs to a different controller");
    }
    if (source.controllerInput.injection) {
      throw new Error("Source injection outcome pending");
    }
    return source.controllerInput;
  }
  const input = reserveSessionControllerSource(key, {
    sourceTurnId: source.sourceTurnId,
    protocolRunId: options?.protocolRunId,
    policy,
    target: resolveSourceTarget(key, source, options?.storePath),
  });
  bindSessionControllerSource(input, source);
  return input;
}

/** A native command may resolve its execution target after out-of-band handling.
 * Move its still-unbound source, not its identity/custody or a second reservation. */
export function retargetSessionControllerSource(
  input: SessionControllerInput,
  target: SessionTarget,
  transfer: "same-store" | "command-target" = "same-store",
): void {
  const assertUnbound = () => {
    if (!isUnboundPreparingSource(input)) {
      throw new Error("Only unbound preparing sources may change execution target");
    }
    input.abortSignal.throwIfAborted();
  };
  assertUnbound();
  input.sourceAdapter?.authority?.assertCurrent();
  assertUnbound();
  const previous = input.mailbox;
  if (
    (input.sourceAdapter?.scope && input.sourceAdapter.scope !== target.storeScope) ||
    (transfer === "same-store" &&
      previous.owner.target &&
      previous.owner.target.storeScope !== target.storeScope)
  ) {
    throw new Error("Source cannot leave its admitted physical store");
  }
  const next = getSessionControllerMailbox(target.sessionKey, target);
  input.target = target;
  if (previous === next) {
    return;
  }
  const index = previous.entries.indexOf(input);
  if (index < 0) {
    throw new Error("Source no longer belongs to its captured mailbox");
  }
  previous.entries.splice(index, 1);
  if (previous.priority === input) {
    previous.priority = undefined;
  }
  input.mailbox = next;
  input.sequence = ++next.nextSequence;
  next.entries.push(input);
  if (input.policy.mode === "interrupt") {
    next.priority = input;
  }
  previous.wake();
}
