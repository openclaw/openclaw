import type { DatabasePortRecoveryIntent } from "./database-port-recovery.js";
import type { GatewayLockRole } from "./gateway-lock-payload.js";
import type { GatewayOwnerSupervisor } from "./gateway-owner-lease.types.js";
import type { GatewayStateProjection } from "./gateway-state-owner.js";

export type GatewayLockHandle = {
  lockPath: string;
  stateLockPath: string;
  stateDir: string;
  assertCurrent(this: void, assertPolicy?: () => void, access?: "read"): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  retainProjection: () => GatewayStateProjection;
  releaseInTree: () => Promise<void>;
  release: () => Promise<void>;
  run<T>(operation: () => T): T;
};

export type GatewayLockOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  lifecycleDeadlineMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
  allowInTests?: boolean;
  platform?: NodeJS.Platform;
  port?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockDir?: string;
  role?: GatewayLockRole;
  assertCurrent?: () => void;
  onWait?: (message: string) => void;
  /** Transfer a relocated Doctor root only after the target exclusion is held. */
  relocatedMaintenanceOwner?: GatewayLockHandle;
  /** Internal offline port recovery; validated only after acquiring fresh physical custody. */
  databasePortRecovery?: DatabasePortRecoveryIntent;
  listenerMode?: "foreground" | "supervised";
  supervisor?: GatewayOwnerSupervisor | null;
  /** Override process command-line reader (testing seam). */
  readProcessCmdline?: (pid: number) => string[] | null;
  /** Override process start-identity reader (testing seam). */
  readProcessStartTime?: (pid: number) => number | null;
};
