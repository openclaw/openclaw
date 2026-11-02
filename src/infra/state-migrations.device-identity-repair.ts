// Owner-authorized detection and Doctor-only replacement for invalid device identity rows.
import path from "node:path";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import {
  DeviceIdentityStorageError,
  generateStoredDeviceIdentity,
  readStoredDeviceIdentityReadOnly,
  repairInvalidStoredDeviceIdentity,
} from "./device-identity-store.js";
import { formatErrorMessage } from "./errors.js";
import { pathMayExistSync } from "./path-existence.js";
import type {
  LegacyDeviceIdentityDetection,
  LegacyDeviceIdentitySource,
} from "./state-migrations.device-identity.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const NATIVE_CLAIM_SUFFIX = ".native-importing";

/** Detect retired paths for an authorized importer; only Doctor may rotate invalid SQLite state. */
export function detectLegacyDeviceIdentity(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): LegacyDeviceIdentityDetection {
  const sources = (
    [
      ["primary", "device.json"],
      ["node", "node-device.json"],
      ["shareExtension", "share-device.json"],
    ] as const
  ).map(([identityKey, filename]) => {
    const sourcePath = path.join(params.stateDir, "identity", filename);
    const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
    const nativeClaimPath = `${sourcePath}${NATIVE_CLAIM_SUFFIX}`;
    const doctorAuthorized = params.doctorOnlyStateMigrations === true;
    let hasInvalidCanonical = false;
    if (doctorAuthorized) {
      try {
        // Planning must preserve WAL/SHM files as well as SQLite rows.
        withArtifactPreservingStateReads(() =>
          readStoredDeviceIdentityReadOnly({
            env: { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir },
            identityKey,
          }),
        );
      } catch (error) {
        hasInvalidCanonical = error instanceof DeviceIdentityStorageError;
      }
    }
    return {
      identityKey,
      sourcePath,
      claimPath,
      nativeClaimPath,
      hasLegacy:
        doctorAuthorized &&
        (pathMayExistSync(claimPath) ||
          pathMayExistSync(nativeClaimPath) ||
          pathMayExistSync(sourcePath)),
      hasInvalidCanonical,
    };
  });
  return {
    sources,
    hasLegacy: sources.some((source) => source.hasLegacy),
    hasInvalidCanonical: sources.some((source) => source.hasInvalidCanonical),
  };
}

export function hasLegacyDeviceIdentityPath(detected: LegacyDeviceIdentitySource): boolean {
  return (
    pathMayExistSync(detected.claimPath) ||
    pathMayExistSync(detected.nativeClaimPath) ||
    pathMayExistSync(detected.sourcePath)
  );
}

/** Generate a replacement only after the caller acquires Doctor's exclusive state lock. */
export function repairInvalidCanonicalIdentity(
  env: NodeJS.ProcessEnv,
  identityKey: LegacyDeviceIdentitySource["identityKey"],
): MigrationMessages {
  try {
    const result = repairInvalidStoredDeviceIdentity(generateStoredDeviceIdentity(), {
      env,
      identityKey,
    });
    if (!result.repaired) {
      return { changes: [], warnings: [] };
    }
    if (!result.rotated) {
      return {
        changes: [`Repaired invalid ${identityKey} device identity metadata in SQLite.`],
        warnings: [],
      };
    }
    return {
      changes: [`Replaced invalid ${identityKey} device identity in SQLite.`],
      warnings: [],
      notices: ["The repaired device has a new identity and must be approved again."],
    };
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed repairing invalid SQLite device identity: ${formatErrorMessage(error)}`],
    };
  }
}
