import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime-state.js";

export type RuntimeSecretsActivationParams = {
  reason: "startup" | "reload" | "restart-check";
  activate: boolean;
  /** This preparation belongs to a live reload; publish failure against the active snapshot. */
  publishFailureAsDegraded?: boolean;
  /** Reject warning publication after a speculative reload loses transaction ownership. */
  canPublishFailureAsDegraded?: () => boolean;
  env?: NodeJS.ProcessEnv;
  includeAuthStoreRefs?: boolean;
  /** Raw config source paired with an otherwise fully activated prepared snapshot. */
  runtimeSourceConfig?: OpenClawConfig;
  /** Defer degradation/recovery publication until a larger transaction can no longer roll back. */
  deferStatePublication?: boolean;
  /** SecretRefs that must not retain last-known-good values during this reload. */
  forceColdRefKeys?: ReadonlySet<string>;
};

/** Gateway startup hook that prepares secrets and optionally activates the prepared snapshot. */
export type ActivateRuntimeSecrets = ((
  config: OpenClawConfig,
  params: RuntimeSecretsActivationParams,
) => Promise<PreparedSecretsRuntimeSnapshot>) & {
  activatePreparedSnapshot: (
    snapshot: PreparedSecretsRuntimeSnapshot,
    params: RuntimeSecretsActivationParams,
  ) => Promise<PreparedSecretsRuntimeSnapshot>;
  activatePreparedSnapshotIfCurrent: (
    snapshot: PreparedSecretsRuntimeSnapshot,
    expectedRevision: number,
    params: RuntimeSecretsActivationParams,
    onActivated?: (
      restore: ActivateRuntimeSecrets["restoreSnapshotIfCurrent"],
    ) => void | Promise<void>,
    canActivate?: () => boolean,
    checkpoint?: () => Promise<void>,
  ) => Promise<PreparedSecretsRuntimeSnapshot | null>;
  restoreSnapshotIfCurrent: (
    snapshot: PreparedSecretsRuntimeSnapshot | null,
    expectedRevision: number,
    ownedSnapshot: PreparedSecretsRuntimeSnapshot,
    options?: { onActivated?: () => void; runtimeSourceConfig?: OpenClawConfig },
  ) => Promise<boolean>;
  publishStateTransition: (
    snapshot: PreparedSecretsRuntimeSnapshot,
    options?: { sourceOnly?: boolean; expectedRevision?: number },
  ) => void;
};
