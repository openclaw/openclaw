import type { InternalSessionEntry } from "./main-session-recovery.types.js";

export type CoreRestartRecoverySessionEntryKey = Extract<
  keyof InternalSessionEntry,
  "mainRestartRecovery" | `restartRecovery${string}`
>;

/** Core owns this namespace; plugin-visible session rows must never expose or accept it. */
export function isCoreRestartRecoverySessionEntryKey(key: PropertyKey): boolean {
  return (
    key === "mainRestartRecovery" || (typeof key === "string" && key.startsWith("restartRecovery"))
  );
}
