import type { DatabasePortRecoveryIntent } from "./database-port-recovery.js";
import type { GatewayLockRole } from "./gateway-lock-payload.js";
import type { GatewayOwnerSupervisor } from "./gateway-owner-lease.types.js";

export type GatewayLockHandle = {
  lockPath: string;
  stateLockPath: string;
  stateDir: string;
  assertCurrent(this: void, assertPolicy?: () => void, access?: "read"): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  release: () => Promise<void>;
  run<T>(operation: () => T): T;
  markListening?: () => void;
};

export type GatewayLockOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  lifecycleDeadlineMs?: number;
  pollIntervalMs?: number;
  allowInTests?: boolean;
  platform?: NodeJS.Platform;
  port?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockDir?: string;
  role?: GatewayLockRole;
  assertCurrent?: () => void;
  onWait?: (message: string) => void;
  /** Internal offline port recovery; validated only after acquiring fresh physical custody. */
  databasePortRecovery?: DatabasePortRecoveryIntent;
  /** Config-only repairs retain file custody without inspecting or admitting database work. */
  databaseAccess?: "none";
  listenerMode?: "foreground" | "supervised";
  supervisor?: GatewayOwnerSupervisor | null;
};
