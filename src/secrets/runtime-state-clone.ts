import type { OwnedRuntimeAuthProfileStoreSnapshotEntry } from "../agents/auth-profiles/runtime-snapshots.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DegradedSecretOwner, SecretOwnerRefState } from "./runtime-degraded-state.js";
import type { SecretResolverWarning } from "./runtime-shared.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

/** Prepared secrets runtime snapshot activated for fast secret resolution. */
export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: OwnedRuntimeAuthProfileStoreSnapshotEntry[];
  authStoreCredentialsRevision: number;
  authStoreSnapshotsRevision: number;
  warnings: SecretResolverWarning[];
  degradedOwners?: DegradedSecretOwner[];
  secretOwners?: SecretOwnerRefState[];
  webTools: RuntimeWebToolsMetadata;
};

/** Return mutable copies; the publication owner freezes its source revision separately. */
export function cloneSecretsRuntimeSnapshot(
  snapshot: PreparedSecretsRuntimeSnapshot,
  authStores: PreparedSecretsRuntimeSnapshot["authStores"],
): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: cloneConfigWithResolutionFacts(snapshot.sourceConfig),
    config: cloneConfigWithResolutionFacts(snapshot.config),
    authStores,
    authStoreCredentialsRevision: snapshot.authStoreCredentialsRevision,
    authStoreSnapshotsRevision: snapshot.authStoreSnapshotsRevision,
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
    degradedOwners: structuredClone(snapshot.degradedOwners ?? []),
    secretOwners: structuredClone(snapshot.secretOwners ?? []),
    webTools: structuredClone(snapshot.webTools),
  };
}
