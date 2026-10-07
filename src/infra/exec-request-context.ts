import { AsyncLocalStorage } from "node:async_hooks";
import { isAgentRunDirectAbortReason } from "../agents/run-termination.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createAbortError } from "./abort-signal.js";

export type ExecRequestIdentity = {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  controlUiVisible?: boolean;
  turnKind?: "main" | "btw";
};

/** Process-local ownership of ordinary commands, independent of a disposable tool call. */
export type ExecRequestOwner = {
  identity: Readonly<ExecRequestIdentity>;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly pendingProcesses: Set<Promise<void>>;
};

type ExecRequestTurn = {
  identity: ExecRequestIdentity;
  owners: readonly ExecRequestOwner[];
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.execRequestContext"), () => ({
  context: new AsyncLocalStorage<ExecRequestTurn>(),
  turns: new Set<ExecRequestTurn>(),
}));
const EVENT_OWNERS = Symbol.for("openclaw.execRequestEventOwners");
type OwnedEvent = { [EVENT_OWNERS]?: readonly ExecRequestOwner[] };

function createExecRequestOwner(identity: ExecRequestIdentity): ExecRequestOwner {
  const controller = new AbortController();
  return {
    identity: Object.freeze({ ...identity }),
    controller,
    signal: controller.signal,
    pendingProcesses: new Set(),
  };
}

export function cancelExecRequestOwners(owners: readonly ExecRequestOwner[]): void {
  for (const owner of owners) {
    if (!owner.controller.signal.aborted) {
      const reason = createAbortError("The request that owns this command was stopped");
      owner.controller.abort(reason);
    }
  }
}

export function execRequestMatches(owner: ExecRequestOwner, target: ExecRequestIdentity): boolean {
  return (
    (target.runId === undefined || owner.identity.runId === target.runId) &&
    (target.sessionKey === undefined || owner.identity.sessionKey === target.sessionKey) &&
    (target.sessionId === undefined || owner.identity.sessionId === target.sessionId) &&
    (target.agentId === undefined || owner.identity.agentId === target.agentId)
  );
}

/** Capture at tool construction: Code Mode invokes the bound tool from a later callback. */
export function captureExecRequestOwners(
  identity: ExecRequestIdentity,
): readonly ExecRequestOwner[] | undefined {
  const turn = state.context.getStore();
  return turn &&
    turn.identity.runId === identity.runId &&
    turn.identity.sessionId === identity.sessionId
    ? turn.owners
    : undefined;
}

export function activeExecRequestOwners(
  target: ExecRequestIdentity,
  accept: (identity: ExecRequestIdentity) => boolean,
): ExecRequestOwner[] {
  return Array.from(
    new Set(
      [...state.turns].flatMap(({ identity, owners }) => {
        const active =
          (target.runId === undefined || identity.runId === target.runId) &&
          (target.sessionKey === undefined || identity.sessionKey === target.sessionKey) &&
          (target.sessionId === undefined || identity.sessionId === target.sessionId) &&
          (target.agentId === undefined || identity.agentId === target.agentId) &&
          accept(identity);
        return active
          ? owners
          : owners.filter((owner) => execRequestMatches(owner, target) && accept(owner.identity));
      }),
    ),
  );
}

/** Only the accepted session binding or compaction owner updates request identity. */
export function adoptExecRequestSession(params: {
  runId: string;
  previousSessionId: string;
  sessionId: string;
}): void {
  const active = state.context.getStore();
  if (
    active?.identity.runId !== params.runId ||
    active.identity.sessionId !== params.previousSessionId
  ) {
    return;
  }
  for (const turn of state.turns) {
    if (
      turn.owners === active.owners &&
      turn.identity.runId === params.runId &&
      turn.identity.sessionId === params.previousSessionId
    ) {
      turn.identity = { ...turn.identity, sessionId: params.sessionId };
    }
  }
  for (const owner of active.owners) {
    if (owner.identity.sessionId === params.previousSessionId) {
      owner.identity = Object.freeze({ ...owner.identity, sessionId: params.sessionId });
    }
  }
}

/** Native process finalization owns settlement; normal turn completion does not join it. */
export function retainExecRequestProcess(
  owners: readonly ExecRequestOwner[] | undefined,
  settlement: Promise<void>,
): void {
  if (!owners?.length) {
    return;
  }
  for (const owner of owners) {
    owner.pendingProcesses.add(settlement);
  }
  const release = () => {
    for (const owner of owners) {
      owner.pendingProcesses.delete(settlement);
    }
  };
  void settlement.then(release, release);
}

/** Nested execution retains its request; a different human turn starts fresh. */
export async function withExecRequestTurn<T>(
  params: {
    identity: ExecRequestIdentity;
    owners?: readonly ExecRequestOwner[];
    abortSignal?: AbortSignal;
  },
  run: () => Promise<T>,
): Promise<T> {
  const outer = state.context.getStore();
  const sameTurn =
    outer?.identity.runId === params.identity.runId &&
    outer?.identity.sessionId === params.identity.sessionId
      ? outer
      : undefined;
  const identity = sameTurn?.identity ?? params.identity;
  const inherited = params.owners ?? sameTurn?.owners;
  const owners = inherited?.length ? inherited : [createExecRequestOwner(identity)];
  for (const owner of owners) {
    owner.signal.throwIfAborted();
  }
  const turn = { identity, owners };
  const stop = () => {
    // Only the current run's explicit cancellation owner carries this marker.
    // Handler retirement and inherited event cancellation preserve other owners.
    if (isAgentRunDirectAbortReason(params.abortSignal?.reason)) {
      cancelExecRequestOwners(owners);
    }
  };
  state.turns.add(turn);
  params.abortSignal?.addEventListener("abort", stop, { once: true });
  if (params.abortSignal?.aborted) {
    stop();
  }
  try {
    return await state.context.run(turn, run);
  } finally {
    // Accepted cancellation joins physical cleanup before the request can settle.
    try {
      await Promise.all(
        owners.flatMap((owner) => (owner.signal.aborted ? Array.from(owner.pendingProcesses) : [])),
      );
    } finally {
      state.turns.delete(turn);
      params.abortSignal?.removeEventListener("abort", stop);
    }
  }
}

/** Enumerable symbol metadata survives internal option/event copies, but never JSON. */
export function withExecRequestOwners<T extends object>(
  value: T,
  owners: readonly ExecRequestOwner[] | undefined,
): T {
  return owners?.length ? { ...value, [EVENT_OWNERS]: owners } : value;
}

export function readExecRequestOwners(value: object): readonly ExecRequestOwner[] | undefined {
  // SAFETY: withExecRequestOwners is the only symbol writer; JSON input cannot carry it.
  return (value as OwnedEvent)[EVENT_OWNERS];
}

export function execRequestAbortSignal(
  owners: readonly ExecRequestOwner[] | undefined,
  signal?: AbortSignal,
): AbortSignal | undefined {
  if (!owners?.length) {
    return signal;
  }
  const signals = owners.map((owner) => owner.signal);
  return AbortSignal.any(signal ? [signal, ...signals] : signals);
}
