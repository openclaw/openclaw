import type { MainRestartRecoveryState } from "./main-session-recovery.types.js";

export function createRestartRecoveryTombstoneFixture() {
  return {
    cycleId: "cycle-1",
    revision: 4,
    chargedAttempts: 3,
    tombstone: {
      reason: "automatic recovery exhausted",
      recoveredSessionId: "dashboard-successor",
      recoveredSessionKey: "agent:main:dashboard:successor",
    },
  } satisfies MainRestartRecoveryState;
}
