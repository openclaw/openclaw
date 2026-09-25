import type { OpenClawConfig } from "../config/types.openclaw.js";

export type PrepareRuntimeSecretsSnapshot =
  typeof import("../secrets/runtime.js").prepareSecretsRuntimeSnapshot;
export type ActivateRuntimeSecretsSnapshot =
  typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
export type PreparedRuntimeSecretsSnapshot = Awaited<ReturnType<PrepareRuntimeSecretsSnapshot>>;

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
) => Promise<PreparedRuntimeSecretsSnapshot>) & {
  activatePreparedSnapshot: (
    snapshot: PreparedRuntimeSecretsSnapshot,
    params: RuntimeSecretsActivationParams,
  ) => Promise<PreparedRuntimeSecretsSnapshot>;
  activatePreparedSnapshotIfCurrent: (
    snapshot: PreparedRuntimeSecretsSnapshot,
    expectedRevision: number,
    params: RuntimeSecretsActivationParams,
    onActivated?: (
      restore: ActivateRuntimeSecrets["restoreSnapshotIfCurrent"],
    ) => void | Promise<void>,
    canActivate?: () => boolean,
    checkpoint?: () => Promise<void>,
  ) => Promise<PreparedRuntimeSecretsSnapshot | null>;
  restoreSnapshotIfCurrent: (
    snapshot: PreparedRuntimeSecretsSnapshot | null,
    expectedRevision: number,
    ownedSnapshot: PreparedRuntimeSecretsSnapshot,
    options?: { onActivated?: () => void; runtimeSourceConfig?: OpenClawConfig },
  ) => Promise<boolean>;
  publishStateTransition: (
    snapshot: PreparedRuntimeSecretsSnapshot,
    options?: { sourceOnly?: boolean; expectedRevision?: number },
  ) => void;
};
