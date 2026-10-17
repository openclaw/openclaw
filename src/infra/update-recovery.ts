import { z } from "zod";

export const updateRecoverySchema = z.discriminatedUnion("serviceRestartSafe", [
  z.strictObject({
    serviceRestartSafe: z.literal(true),
    packageRollbackVerified: z.literal(true).optional(),
    version: z.string().trim().min(1),
    buildId: z.string().trim().min(1).max(96).optional(),
    service: z.enum(["healthy", "failed"]).optional(),
    reason: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    serviceRestartSafe: z.literal(false),
    dataAtRisk: z.string().trim().min(1).optional(),
    packageRollbackVerified: z.boolean().optional(),
    reason: z.enum([
      "source-rollback-failed",
      "state-migration-started",
      "manager-unavailable",
      "deps-install-failed",
      "build-failed",
      "rollback-checkout-dirty",
      "runtime-verification-failed",
    ]),
  }),
]);

export type UpdateRecovery = z.infer<typeof updateRecoverySchema>;

/** Secondary recovery failures retain the owner's stronger restart refusal. */
export function unsafeUpdateRecovery(
  recovery: UpdateRecovery | undefined,
  dataAtRisk?: string,
): Extract<UpdateRecovery, { serviceRestartSafe: false }> {
  const unsafe = recovery?.serviceRestartSafe === false ? recovery : undefined;
  return {
    ...unsafe,
    serviceRestartSafe: false,
    reason:
      unsafe?.reason ?? (dataAtRisk ? "state-migration-started" : "runtime-verification-failed"),
    dataAtRisk: unsafe?.dataAtRisk ?? dataAtRisk,
  };
}
