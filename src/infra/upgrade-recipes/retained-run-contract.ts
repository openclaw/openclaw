import { z } from "zod";
import { retainedUpgradeRecipeRunSchema } from "./recovery-contract.js";

const artifactSchema = retainedUpgradeRecipeRunSchema.shape.planArtifact;
export const pointerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  originalCreatedAtMs: z.number().int().nonnegative(),
  envelope: artifactSchema,
  nativeAuthority: retainedUpgradeRecipeRunSchema.shape.nativeAuthority,
  ledgerAuthority: retainedUpgradeRecipeRunSchema.shape.ledgerAuthority,
});
export type RetainedUpgradeRecipeRunPointer = z.infer<typeof pointerSchema>;
export type UpgradeRecipeRetainedRunWriteOperations = {
  "upgradeRecipeRuns.retain": {
    input: RetainedUpgradeRecipeRunPointer;
    output: RetainedUpgradeRecipeRunPointer;
  };
};
