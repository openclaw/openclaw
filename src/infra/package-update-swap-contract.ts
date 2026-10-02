import type { LocalPackageOverridesResult } from "./package-local-overrides-shared.js";
import type { PackagePostInstallVerifier } from "./package-update-verification-step.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import type { NativePackageStage } from "./update-native-package-stage.js";
import type { NpmGlobalPrefixLayout } from "./update-npm-prefix.js";
import type { UpdateRecoveryFence } from "./update-run-recovery-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type PackageActivationRuntime = {
  kind: "node" | "bun";
  path: string;
  identity: string;
  /** Preflight snapshot filtered by the daemon runtime probe owner. */
  env?: NodeJS.ProcessEnv;
};

export type PackageActivationOptions = {
  fence: UpdateRecoveryFence;
  runtime: PackageActivationRuntime;
  onPrepared: (command: string) => void;
  onUnavailable?: (message: string) => void;
};

/** The orchestrator owns schema safety and service verification before confirming or restoring. */
export type PackageUpdateTransaction = {
  backupRoot: string;
  /** Migration snapshots must outlive the journal's package-only retirement. */
  databaseBackupRoot?: string;
  assertRollbackSafe?: () => Promise<void>;
  rollback: (
    assertCurrent: () => void,
  ) => Promise<
    UpdateStepResult & { activePackageRoot: string | null; reason?: "rollback-project-changed" }
  >;
  complete: (
    outcome: { activationVerified: boolean },
    assertCurrent: () => void,
  ) => Promise<UpdateStepResult | void>;
};

// Service suspension and cancellation belong to the caller. Carry their exact
// cause through package failure handling without reclassifying service safety.
export class PackageUpdateActivationError extends Error {
  constructor(cause: unknown) {
    super("Package activation preparation failed", { cause });
  }
}

export type StagedPackageInstall = {
  prefix: string;
  layout: NpmGlobalPrefixLayout;
  packageRoot: string;
  installTarget: ResolvedGlobalInstallTarget;
  native?: NativePackageStage;
  activationCustody?: boolean;
};

export type StagedPackageSwapParams = {
  stage: StagedPackageInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  postVerifyStep?: PackagePostInstallVerifier;
  beforeActivate?: () => Promise<void>;
  assertCurrent?: () => void;
  reserveInstallSlot?: (root: string) => void;
  onLiveMutation?: () => void;
  onTransaction?: (transaction: PackageUpdateTransaction) => void | Promise<void>;
  timeoutMs?: number;
  activation?: PackageActivationOptions;
  localOverrides?: { reapply: boolean; env?: NodeJS.ProcessEnv };
  onLocalOverrides?: (result: LocalPackageOverridesResult) => void;
};

export type StagedPackageSwapResult =
  | {
      status: "committed";
      activePackageRoot: string | null;
      step: UpdateStepResult;
      postVerifyStep: UpdateStepResult | null;
    }
  | {
      status: "failed";
      activePackageRoot: string | null;
      step: UpdateStepResult;
      postVerifyStep: UpdateStepResult | null;
      packageRollbackVerified: boolean;
    };
