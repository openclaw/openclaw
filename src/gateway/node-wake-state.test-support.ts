import { nodeWakeStateByOwner, nodeWakeStateKey } from "./node-wake-state-store.js";
import { runNodeWakeAttempt, runNodeWakeNudgeAttempt } from "./node-wake-state.js";

/** Read-only test projection; callers cannot mutate lifecycle ownership. */
export function getNodeWakeStateSnapshot(
  nodeId: string,
  pairingGeneration?: string,
):
  | {
      lastWakeAtMs: number | undefined;
      wakeInFlight: boolean;
      lastNudgeAtMs: number | undefined;
      lifecycleUsers: number;
    }
  | undefined {
  const owner = nodeWakeStateByOwner.get(nodeWakeStateKey(nodeId, pairingGeneration));
  return owner
    ? {
        lastWakeAtMs: owner.lastWakeAtMs,
        wakeInFlight: owner.inFlightWake !== undefined,
        lastNudgeAtMs: owner.lastNudgeAtMs,
        lifecycleUsers: owner.lifecycle?.users ?? 0,
      }
    : undefined;
}

export function resetNodeWakeStateForTest(): void {
  for (const owner of nodeWakeStateByOwner.values()) {
    owner.lifecycle?.controller.abort();
  }
  nodeWakeStateByOwner.clear();
}

export async function seedNodeWakeState(nodeId: string): Promise<void> {
  await runNodeWakeAttempt({
    nodeId,
    force: true,
    throttleMs: 60_000,
    attempt: async (markAttempted) => {
      markAttempted();
      return { available: true, throttled: false, path: "sent", durationMs: 1 };
    },
  });
  await runNodeWakeNudgeAttempt({
    nodeId,
    throttleMs: 60_000,
    throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
    attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
  });
}
