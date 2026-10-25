import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

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
