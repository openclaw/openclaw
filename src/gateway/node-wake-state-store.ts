import type { NodeWakeAttempt } from "./node-wake-state.js";

export type NodeWakeOwnerState = {
  nodeId: string;
  stateKey: string;
  // Process-local monotonic times; wall-clock changes must not alter throttling.
  lastWakeAtMs?: number;
  inFlightWake?: Promise<NodeWakeAttempt>;
  lastNudgeAtMs?: number;
  lifecycle?: {
    controller: AbortController;
    users: number;
  };
};

export const nodeWakeStateByOwner = new Map<string, NodeWakeOwnerState>();
export const nodeWakeOwnerBySignal = new WeakMap<AbortSignal, NodeWakeOwnerState>();

export function nodeWakeStateKey(nodeId: string, pairingGeneration?: string): string {
  return JSON.stringify([nodeId.trim(), pairingGeneration?.trim() || null]);
}
