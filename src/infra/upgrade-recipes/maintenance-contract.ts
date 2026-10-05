import { z } from "zod";

const identity = z.string().min(1).max(4096);
export const upgradeRecipeMaintenanceBindingSchema = z.strictObject({
  protocol: z.literal(1),
  runId: identity,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  targetArtifactId: identity,
  installationKey: identity,
  stateRootKey: identity,
});
export const upgradeRecipeMaintenanceReceiptSchema = z.strictObject({
  binding: upgradeRecipeMaintenanceBindingSchema,
  phase: z.enum(["maintenance-required", "commit-intent", "committed"]),
  revision: z.number().int().positive().safe(),
  updatedAtMs: z.number().int().nonnegative().safe(),
});
export type UpgradeRecipeMaintenanceBinding = z.infer<typeof upgradeRecipeMaintenanceBindingSchema>;
export type UpgradeRecipeMaintenanceReceipt = z.infer<typeof upgradeRecipeMaintenanceReceiptSchema>;
export type UpgradeRecipeMaintenanceWriteInput = {
  binding: UpgradeRecipeMaintenanceBinding;
  expectedRevision: number | null;
  phase: UpgradeRecipeMaintenanceReceipt["phase"];
};
export type UpgradeRecipeMaintenanceWriteOperations = {
  "upgradeMaintenance.record": {
    input: UpgradeRecipeMaintenanceWriteInput;
    output: UpgradeRecipeMaintenanceReceipt;
  };
};

/** COMMIT_INTENT is the conservative external-work boundary, not confirmed success. */
export function mayUpgradeRecipeExternalWorkHaveOccurred(
  receipt: UpgradeRecipeMaintenanceReceipt,
): boolean {
  return receipt.phase !== "maintenance-required";
}

/** Current evidence prohibits compensation; matching evidence never authorizes it. */
export function assertUpgradeRecipeReceiptRollbackAllowed(
  receipt: UpgradeRecipeMaintenanceReceipt | null,
  runId: string | undefined,
): void {
  if (
    receipt &&
    (receipt.phase === "commit-intent" ||
      (receipt.binding.runId === runId && receipt.phase === "committed") ||
      (receipt.binding.runId !== runId && receipt.phase === "maintenance-required"))
  ) {
    throw new Error(
      "Rollback refused: unresolved upgrade ownership or external work is possible; preserve current state and resume its original owner.",
    );
  }
}

export type UpgradeRecipeMaintenanceStateReadOperations = {
  "upgradeMaintenance.read": {
    input: undefined;
    output: { type: "upgradeMaintenance.read"; receipt: UpgradeRecipeMaintenanceReceipt | null };
  };
};
