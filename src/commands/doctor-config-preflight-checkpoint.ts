import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  MigrationCheckpointIdentity,
  StartupMigrationLease,
} from "../infra/startup-migration-checkpoint.js";
import { resolveStateMigrationConfigInput } from "./doctor/shared/legacy-config-state-migration-input.js";

/** Renew through awaited admission and surface a lost lease before the next write. */
export function keepStartupMigrationLeaseAlive(lease: StartupMigrationLease, intervalMs: number) {
  let failure: Error | undefined;
  const timer = setInterval(() => {
    try {
      lease.heartbeat();
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new Error("OpenClaw startup migration lease heartbeat failed.");
    }
  }, intervalMs);
  timer.unref?.();
  return {
    get error() {
      return failure;
    },
    throwIfFailed() {
      if (failure) {
        throw failure;
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export function resolveMigrationCheckpointIdentity(params: {
  snapshot: ConfigFileSnapshot;
  baseConfig: OpenClawConfig;
  pluginMigrationFingerprint: string | null;
}): MigrationCheckpointIdentity | null {
  if (!params.snapshot.valid || !params.pluginMigrationFingerprint) {
    return null;
  }
  const stateMigrationInput = resolveStateMigrationConfigInput({
    snapshot: params.snapshot,
    baseConfig: params.baseConfig,
  });
  const effectiveConfig = stateMigrationInput?.cfg ?? params.baseConfig;
  const pluginDoctorConfig = stateMigrationInput?.pluginDoctorConfig ?? effectiveConfig;
  return {
    effectiveConfigFingerprint: hashRuntimeConfigValue(effectiveConfig),
    pluginDoctorConfigFingerprint: hashRuntimeConfigValue(pluginDoctorConfig),
    pluginMigrationFingerprint: params.pluginMigrationFingerprint,
  };
}

export function migrationCheckpointIdentitiesMatch(
  left: MigrationCheckpointIdentity | null,
  right: MigrationCheckpointIdentity | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.effectiveConfigFingerprint === right.effectiveConfigFingerprint &&
    left.pluginDoctorConfigFingerprint === right.pluginDoctorConfigFingerprint &&
    left.pluginMigrationFingerprint === right.pluginMigrationFingerprint
  );
}
