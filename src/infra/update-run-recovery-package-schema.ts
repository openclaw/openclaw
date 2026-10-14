import { z } from "zod";
import {
  PackageRecoveryEffectSchema,
  PackageTransactionDescriptorSchema,
} from "./package-update-recovery-contract.js";

/** Private storage validation of the producer's typed facts, not evidence of live authority. */
const RecoveryPackageObservationSchema = z.strictObject({
  status: z.literal("verified"),
  descriptor: PackageTransactionDescriptorSchema,
  observation: z.strictObject({
    previous: z.enum(["live", "retained", "absent"]),
    candidate: z.enum(["live", "staged", "displaced", "absent"]),
    launchers: z.enum(["previous", "candidate", "both", "mixed", "interrupted"]),
    successorLive: z.boolean(),
  }),
  observedIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const RecoveryPackageStateSchema = z.strictObject({
  descriptor: PackageTransactionDescriptorSchema,
  observed: RecoveryPackageObservationSchema,
});
export const RecoveryPackageEffectSchema = z.strictObject({
  intent: PackageRecoveryEffectSchema,
  observed: RecoveryPackageObservationSchema.optional(),
  outcome: z.enum(["completed", "interrupted"]).optional(),
});
