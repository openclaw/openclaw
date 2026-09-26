import type { PackageActivationReverseBinding } from "./package-update-activation-reverse-schema.js";
import type {
  UpdateRecoverySourceAttestation,
  UpdateRecoverySourceRef,
} from "./update-recovery-source-schema.js";

export type PackageReverseAuthority = {
  assertCurrent: () => void;
  assertWritersSettled: () => void;
  assertCapturedSource?: (
    ref: Readonly<UpdateRecoverySourceRef>,
    source: Readonly<UpdateRecoverySourceAttestation>,
  ) => void;
  validateTarget: (binding: Readonly<PackageActivationReverseBinding>) => Promise<void>;
  beforeStatePublication: (binding: Readonly<PackageActivationReverseBinding>) => void;
};
