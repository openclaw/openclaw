import { resolveGlobalSingleton } from "../shared/global-singleton.ts";
import { notifyListeners, registerListener } from "../shared/listeners.ts";

export type GatewayWorkMetricsSnapshot = {
  sessions: { running: number; queued: number };
  work: { agentRuns: number; chatRuns: number; queuedTurns: number };
};

type Listener = (snapshot: GatewayWorkMetricsSnapshot | undefined) => void;

export type SessionRowSelectionKind =
  | "broad"
  | "agent"
  | "store"
  | "exact"
  | "session-id"
  | "parent"
  | "running-candidate";

type SessionRowSelectionMetric = {
  kind: SessionRowSelectionKind;
  task: string;
  calls: number;
  rows: number;
};

const rowSelections = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionRowSelectionMetrics"),
  () => ({
    counters: new Map<string, Map<SessionRowSelectionKind, SessionRowSelectionMetric>>(),
    resets: 0,
  }),
);

/** Keep caller attribution bounded and free of session, agent, or request identities. */
function selectionTask(task: string | undefined): string {
  switch (task) {
    case "gateway:rpc:sessions.list":
      return "sessions.list";
    case "gateway:rpc:sessions.catalog.list":
      return "sessions.catalog.list";
    case "gateway:rpc:sessions.resolve":
      return "sessions.resolve";
    case "gateway:rpc:sessions.usage":
      return "sessions.usage";
    case "gateway:rpc:status":
    case "gateway:rpc:health":
      return "status";
    case "gateway:rpc:controlUi.sessionPullRequests.subscribe":
    case "gateway:rpc:controlUi.sessionPullRequests.checks":
    case "scheduler:control-ui-session-pr-poll":
      return "control-ui-pr";
    default:
      return "other";
  }
}

/** Successful selections update scalar totals; snapshots allocate outside the selector. */
export function recordSessionRowSelection(
  kind: SessionRowSelectionKind,
  rows: number,
  task: string | undefined,
): void {
  const caller = selectionTask(task);
  let kinds = rowSelections.counters.get(caller);
  if (!kinds) {
    rowSelections.counters.set(caller, (kinds = new Map()));
  }
  let counter = kinds.get(kind);
  if (!counter) {
    kinds.set(kind, (counter = { kind, task: caller, calls: 0, rows: 0 }));
  }
  counter.calls++;
  counter.rows += rows;
}

export function recordSessionRowSelectionReset(): void {
  rowSelections.resets++;
}

export function getSessionRowSelectionMetrics() {
  return {
    selections: [...rowSelections.counters.values()].flatMap((kinds) =>
      [...kinds.values()].map((counter) => Object.assign({}, counter)),
    ),
    resets: rowSelections.resets,
  };
}

const state = resolveGlobalSingleton<{
  snapshot: GatewayWorkMetricsSnapshot | undefined;
  listeners: Set<Listener>;
  demand: { onChanged: () => void };
}>(Symbol.for("openclaw.gatewayWorkMetrics"), () => ({
  snapshot: undefined,
  listeners: new Set<Listener>(),
  demand: { onChanged: () => {} },
}));

export const gatewayWorkMetricsDemand = state.demand;

/** The Gateway projection publishes after owner changes and clears on shutdown. */
export function publishGatewayWorkMetrics(snapshot: GatewayWorkMetricsSnapshot | undefined): void {
  state.snapshot = snapshot;
  notifyListeners(state.listeners, snapshot);
}

/** Replay the current projection when an exporter starts or restarts. */
export function onGatewayWorkMetrics(listener: Listener): () => void {
  const wasEmpty = state.listeners.size === 0;
  const unsubscribe = registerListener(state.listeners, listener);
  if (wasEmpty) {
    notifyListeners([state.demand.onChanged], undefined);
  }
  notifyListeners([listener], state.snapshot);
  return () => {
    const subscribed = state.listeners.has(listener);
    unsubscribe();
    if (subscribed && state.listeners.size === 0) {
      notifyListeners([state.demand.onChanged], undefined);
    }
  };
}

export function hasGatewayWorkMetricsListeners(): boolean {
  return state.listeners.size > 0;
}
