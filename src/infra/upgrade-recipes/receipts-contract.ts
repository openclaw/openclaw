import { z } from "zod";

const identity = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const resource = z.strictObject({
  resourceKey: identity,
  identityDigest: digest,
  beforeDigest: digest,
  expectedAfterDigest: digest,
  snapshotArtifactDigest: digest.optional(),
});
const resources = z
  .array(resource)
  .min(1)
  .max(64)
  .refine(
    (items) => new Set(items.map((item) => item.resourceKey)).size === items.length,
    "Duplicate recipe receipt resource identity.",
  );

/** Correlation and retained evidence only; no serialized field conveys an update lease. */
export const upgradeRecipeStepBindingSchema = z.strictObject({
  protocol: z.literal(1),
  runId: identity,
  planDigest: digest,
  stepId: identity,
  recipeId: identity,
  recipeRevision: z.number().int().positive().safe(),
  adapterId: identity,
  adapterRevision: z.number().int().positive().safe(),
  adapterArtifactDigest: digest,
  phase: z.enum(["prepare", "quiesced-migrate", "postpublish-maintenance", "verify"]),
  resources,
});
export const upgradeRecipeStepObservationSchema = z.strictObject({
  status: z.enum(["observed", "unavailable"]),
  resources: z
    .array(
      z.strictObject({
        resourceKey: identity,
        identityDigest: digest,
        stateDigest: digest,
      }),
    )
    .max(64)
    .refine(
      (items) => new Set(items.map((item) => item.resourceKey)).size === items.length,
      "Duplicate recipe postcondition resource identity.",
    ),
  diagnosticsArtifactDigest: digest.optional(),
});
export const upgradeRecipeStepReceiptSchema = z
  .strictObject({
    binding: upgradeRecipeStepBindingSchema,
    phase: z.enum(["intent", "verified", "outcome-unknown"]),
    revision: z.number().int().positive().safe(),
    intentAtMs: z.number().int().nonnegative().safe(),
    updatedAtMs: z.number().int().nonnegative().safe(),
    observation: upgradeRecipeStepObservationSchema.optional(),
  })
  .refine(
    (receipt) =>
      receipt.phase === "intent"
        ? receipt.observation === undefined
        : receipt.observation !== undefined &&
          (receipt.phase === "verified") ===
            upgradeRecipeStepPostconditionMatches(receipt.binding, receipt.observation),
    "Recipe receipt phase does not match its retained observation.",
  );

export type UpgradeRecipeStepBinding = z.infer<typeof upgradeRecipeStepBindingSchema>;
export type UpgradeRecipeStepObservation = z.infer<typeof upgradeRecipeStepObservationSchema>;
export type UpgradeRecipeStepReceipt = z.infer<typeof upgradeRecipeStepReceiptSchema>;
export const upgradeRecipeStepWriteInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("intent"),
    binding: upgradeRecipeStepBindingSchema,
    expectedRevision: z.null(),
  }),
  z.strictObject({
    kind: z.literal("observation"),
    binding: upgradeRecipeStepBindingSchema,
    expectedRevision: z.number().int().positive().safe(),
    observation: upgradeRecipeStepObservationSchema,
  }),
]);
export type UpgradeRecipeStepWriteInput = z.infer<typeof upgradeRecipeStepWriteInputSchema>;
export type UpgradeRecipeStepWriteOperations = {
  "upgradeRecipeSteps.record": {
    input: UpgradeRecipeStepWriteInput;
    output: UpgradeRecipeStepReceipt;
  };
};

export function parseUpgradeRecipeStepBinding(value: unknown): UpgradeRecipeStepBinding {
  const binding = upgradeRecipeStepBindingSchema.parse(value);
  binding.resources.sort((a, b) =>
    a.resourceKey < b.resourceKey ? -1 : a.resourceKey > b.resourceKey ? 1 : 0,
  );
  return binding;
}

/** A precondition match alone never proves that an interrupted effect may safely be replayed. */
export function upgradeRecipeStepPostconditionMatches(
  binding: UpgradeRecipeStepBinding,
  observation: UpgradeRecipeStepObservation,
): boolean {
  return (
    observation.status === "observed" &&
    observation.resources.length === binding.resources.length &&
    binding.resources.every((expected) => {
      const actual = observation.resources.find(
        (item) => item.resourceKey === expected.resourceKey,
      );
      return (
        actual?.identityDigest === expected.identityDigest &&
        actual.stateDigest === expected.expectedAfterDigest
      );
    })
  );
}
