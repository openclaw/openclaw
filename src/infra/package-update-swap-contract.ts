// Public contracts shared by package activation and its existing callers.
import type { LocalPackageOverridesResult } from "./package-local-overrides-shared.js";
import type {
  PackageActivationDescriptor,
  PackageActivationStatus,
} from "./package-update-activation-journal.js";
import type { PackageReverseResourceCustody } from "./package-update-activation-reverse-resources.js";
import type {
  PackageActivationReverseBinding,
  PackageActivationReversePreparation,
} from "./package-update-activation-reverse-schema.js";
import type { PackageReverseAuthority } from "./package-update-reverse-types.js";
import type { PackagePostInstallVerifier } from "./package-update-verification-step.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import type { NativePackageStage } from "./update-native-package-stage.js";
import type { NpmGlobalPrefixLayout } from "./update-npm-prefix.js";
import type { UpdateRecoveryFence } from "./update-run-recovery-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

type UpdatePublishedStateGeneration = Readonly<
  Pick<
    PackageActivationReverseBinding,
    "operationId" | "runId" | "baseline" | "candidate" | "prepared" | "target"
  > & {
    bindingDigest: string;
    state: Readonly<{ databasePath: string; databaseIdentity: string; parentIdentity: string }>;
  }
>;
export type UpdateRecoveryPublicationCompletion = PackageActivationStatus & {
  publishedState: UpdatePublishedStateGeneration;
};
export type PackageReversePublication = {
  resourceCustody: (
    authority: Pick<PackageReverseAuthority, "assertCurrent" | "assertWritersSettled">,
  ) => Promise<PackageReverseResourceCustody>;
  selection: () => Pick<
    PackageActivationDescriptor,
    "operationId" | "originalRunId" | "previous" | "previousRuntime"
  > & { anchor: string };
  publish: (
    binding: PackageActivationReverseBinding,
    authority: PackageReverseAuthority,
  ) => Promise<PackageActivationStatus>;
  prepare: (
    preparation: PackageActivationReversePreparation,
    authority: PackageReverseAuthority,
  ) => Promise<{ status: PackageActivationStatus; binding: PackageActivationReverseBinding }>;
  settle: (authority: PackageReverseAuthority) => Promise<PackageActivationStatus>;
  verifyCompletion: (
    binding: Readonly<PackageActivationReverseBinding>,
    authority: PackageReverseAuthority,
  ) => Promise<UpdateRecoveryPublicationCompletion>;
  commitCompletion: (
    binding: Readonly<PackageActivationReverseBinding>,
    authority: PackageReverseAuthority,
  ) => Promise<PackageActivationStatus>;
};

export type PackageActivationOptions = {
  runId?: string;
  fence: UpdateRecoveryFence;
  nodeRunner: string;
  onPrepared: (command: string) => void;
  onUnavailable?: (message: string) => void;
};

/** The orchestrator owns schema safety and service verification before confirming or restoring. */
export type PackageUpdateTransaction = {
  reversePublication?: PackageReversePublication;
  backupRoot: string;
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
  onTransaction?: (transaction: PackageUpdateTransaction) => void;
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
