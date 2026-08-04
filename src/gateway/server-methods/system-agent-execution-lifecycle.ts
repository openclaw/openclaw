import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import type { GatewayRequestContext } from "./types.js";

const SYSTEM_AGENT_GATEWAY_EXECUTION_KEY = "gateway";
const SYSTEM_AGENT_RETIRED_SETTLEMENT_WAIT_MS = 1_000;
const systemAgentGatewayExecutionQueues = new WeakMap<
  GatewayRequestContext["systemAgentSessions"],
  KeyedAsyncQueue
>();
const retiredSystemAgentSessionMaps = new WeakSet<GatewayRequestContext["systemAgentSessions"]>();
const activeSystemAgentMutationSettlements = new WeakMap<
  GatewayRequestContext["systemAgentSessions"],
  Set<Promise<void>>
>();
type SystemAgentOwnerExecutionState = {
  active: number;
  retired: boolean;
};
const systemAgentOwnerExecutions = new WeakMap<
  GatewayRequestContext["systemAgentSessions"],
  Map<string, SystemAgentOwnerExecutionState>
>();
let retiredSystemAgentMutationSettlement: Promise<void> = Promise.resolve();

export async function waitForRetiredSystemAgentMutationSettlement(): Promise<void> {
  await retiredSystemAgentMutationSettlement;
}

async function waitForRetiredSystemAgentMutationSettlementForRpc(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          "System-agent setup from the previous Gateway is still finishing; try again shortly.",
        ),
      );
    }, SYSTEM_AGENT_RETIRED_SETTLEMENT_WAIT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([waitForRetiredSystemAgentMutationSettlement(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function getSystemAgentGatewayExecutionQueue(
  sessions: GatewayRequestContext["systemAgentSessions"],
): KeyedAsyncQueue {
  const existing = systemAgentGatewayExecutionQueues.get(sessions);
  if (existing) {
    return existing;
  }
  const queue = new KeyedAsyncQueue();
  systemAgentGatewayExecutionQueues.set(sessions, queue);
  return queue;
}

export function retireSystemAgentGatewayExecution(
  sessions: GatewayRequestContext["systemAgentSessions"],
): Promise<void> {
  retiredSystemAgentSessionMaps.add(sessions);
  systemAgentGatewayExecutionQueues.delete(sessions);
  const settlements = Array.from(activeSystemAgentMutationSettlements.get(sessions) ?? []);
  activeSystemAgentMutationSettlements.delete(sessions);
  return Promise.all(settlements).then(() => undefined);
}

export function retainRetiredSystemAgentMutationSettlement(settlement: Promise<void>): void {
  const previous = retiredSystemAgentMutationSettlement;
  // The fence preserves ordering only. Disposal still reports failures through
  // its own promise; carrying a rejection here would poison every later Gateway.
  retiredSystemAgentMutationSettlement = Promise.allSettled([previous, settlement]).then(
    () => undefined,
  );
}

export function assertSystemAgentGatewayExecutionActive(
  sessions: GatewayRequestContext["systemAgentSessions"],
  ownerKey?: string,
): void {
  if (retiredSystemAgentSessionMaps.has(sessions)) {
    throw new Error("System-agent Gateway generation has been retired.");
  }
  if (ownerKey) {
    assertSystemAgentOwnerExecutionActive(sessions, ownerKey);
  }
}

function assertSystemAgentOwnerExecutionActive(
  sessions: GatewayRequestContext["systemAgentSessions"],
  ownerKey: string,
): void {
  if (systemAgentOwnerExecutions.get(sessions)?.get(ownerKey)?.retired) {
    throw new Error("System-agent connection owner has been retired.");
  }
}

export function retireSystemAgentOwnerExecution(
  sessions: GatewayRequestContext["systemAgentSessions"],
  ownerKey: string,
): void {
  const state = systemAgentOwnerExecutions.get(sessions)?.get(ownerKey);
  if (state) {
    state.retired = true;
  }
}

type SystemAgentOwnerExecutionAdmission = {
  assertActive: () => void;
  release: () => void;
};

/** Fences one owner request from synchronous dispatch until its handler settles. */
export function admitSystemAgentOwnerExecution(
  sessions: GatewayRequestContext["systemAgentSessions"],
  ownerKey: string,
): SystemAgentOwnerExecutionAdmission {
  assertSystemAgentOwnerExecutionActive(sessions, ownerKey);
  const owners: Map<string, SystemAgentOwnerExecutionState> =
    systemAgentOwnerExecutions.get(sessions) ?? new Map();
  const state: SystemAgentOwnerExecutionState = owners.get(ownerKey) ?? {
    active: 0,
    retired: false,
  };
  state.active += 1;
  owners.set(ownerKey, state);
  systemAgentOwnerExecutions.set(sessions, owners);
  let released = false;
  return {
    assertActive: () => assertSystemAgentOwnerExecutionActive(sessions, ownerKey),
    release: () => {
      if (released) {
        return;
      }
      released = true;
      state.active -= 1;
      if (state.active === 0 && owners.get(ownerKey) === state) {
        owners.delete(ownerKey);
        if (owners.size === 0) {
          systemAgentOwnerExecutions.delete(sessions);
        }
      }
    },
  };
}

export async function runSystemAgentGatewayTask<T>(
  task: () => Promise<T>,
  sessions: GatewayRequestContext["systemAgentSessions"],
): Promise<T> {
  // A persistent writer that crossed its commit boundary cannot be cancelled.
  // Preserve the cross-generation fence until every retired writer has settled.
  await waitForRetiredSystemAgentMutationSettlementForRpc();
  assertSystemAgentGatewayExecutionActive(sessions);
  const queue = getSystemAgentGatewayExecutionQueue(sessions);
  // Track every accepted RPC as active, never queued: restart draining snapshots
  // active ids, so a queued OpenClaw request could otherwise outlive its socket.
  setCommandLaneConcurrency(CommandLane.SystemAgent, Number.MAX_SAFE_INTEGER);
  return await enqueueCommandInLane(CommandLane.SystemAgent, () =>
    // Bound expensive detection, activation, and agent turns without hiding
    // accepted work from restart draining. Each Gateway generation owns its
    // queue, so stale work cannot block the replacement server after teardown.
    queue.enqueue(SYSTEM_AGENT_GATEWAY_EXECUTION_KEY, async () => {
      assertSystemAgentGatewayExecutionActive(sessions);
      return await task();
    }),
  );
}

export async function runSystemAgentGatewayOwnerTask<T>(
  ownerKey: string,
  sessions: GatewayRequestContext["systemAgentSessions"],
  task: () => Promise<T>,
): Promise<T> {
  const admission = admitSystemAgentOwnerExecution(sessions, ownerKey);
  try {
    return await runSystemAgentGatewayTask(async () => {
      assertSystemAgentOwnerExecutionActive(sessions, ownerKey);
      return await task();
    }, sessions);
  } finally {
    admission.release();
  }
}

export async function runSystemAgentGatewayMutationTask<T>(
  task: () => Promise<T>,
  sessions: GatewayRequestContext["systemAgentSessions"],
): Promise<T> {
  assertSystemAgentGatewayExecutionActive(sessions);
  let settleMutation: (() => void) | undefined;
  const settlement = new Promise<void>((resolve) => {
    settleMutation = resolve;
  });
  const activeSettlements =
    activeSystemAgentMutationSettlements.get(sessions) ?? new Set<Promise<void>>();
  // Register at admission, before the task can wait behind older work. Restart
  // must fence every accepted writer, including one still queued for execution.
  activeSettlements.add(settlement);
  activeSystemAgentMutationSettlements.set(sessions, activeSettlements);
  try {
    return await runSystemAgentGatewayTask(task, sessions);
  } finally {
    settleMutation?.();
    activeSettlements.delete(settlement);
    if (activeSettlements.size === 0) {
      activeSystemAgentMutationSettlements.delete(sessions);
    }
  }
}
