export type GovdossPlanTier = "community" | "team" | "enterprise" | "regulated";

export type GovdossTenantContext = {
  tenantId: string;
  workspaceId?: string;
  planTier: GovdossPlanTier;
  complianceModes: string[];
  billingAccountId?: string;
  metadata?: Record<string, unknown>;
};

export function createTenantContext(input: {
  tenantId: string;
  workspaceId?: string;
  planTier?: GovdossPlanTier;
  complianceModes?: string[];
  billingAccountId?: string;
  metadata?: Record<string, unknown>;
}): GovdossTenantContext {
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    planTier: input.planTier ?? "team",
    complianceModes: Array.isArray(input.complianceModes) ? input.complianceModes : [],
    billingAccountId: input.billingAccountId,
    metadata: input.metadata,
  };
}

export function isRegulatedTenant(context: GovdossTenantContext): boolean {
  return context.planTier === "regulated" || context.complianceModes.length > 0;
}
