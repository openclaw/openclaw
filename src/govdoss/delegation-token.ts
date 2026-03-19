export type GovdossDelegationMode = "manual-only" | "bounded-autonomy" | "delegated-autonomy" | "emergency-stop";

export type GovdossDelegationToken = {
  id: string;
  tenantId?: string;
  issuedBy: string;
  subject: string;
  mode: GovdossDelegationMode;
  allowedActions: string[];
  allowedPrefixes: string[];
  maxRiskTier: "LOW" | "MEDIUM" | "HIGH";
  maxUses?: number;
  usedCount: number;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  metadata?: Record<string, unknown>;
};

export function createGovdossDelegationToken(input: {
  id: string;
  tenantId?: string;
  issuedBy: string;
  subject: string;
  mode: GovdossDelegationMode;
  allowedActions?: string[];
  allowedPrefixes?: string[];
  maxRiskTier?: "LOW" | "MEDIUM" | "HIGH";
  maxUses?: number;
  ttlMs: number;
  metadata?: Record<string, unknown>;
}): GovdossDelegationToken {
  const now = Date.now();
  return {
    id: input.id,
    tenantId: input.tenantId,
    issuedBy: input.issuedBy,
    subject: input.subject,
    mode: input.mode,
    allowedActions: input.allowedActions ?? [],
    allowedPrefixes: input.allowedPrefixes ?? [],
    maxRiskTier: input.maxRiskTier ?? "LOW",
    maxUses: input.maxUses,
    usedCount: 0,
    issuedAt: now,
    expiresAt: now + input.ttlMs,
    metadata: input.metadata,
  };
}

export function isDelegationActive(token: GovdossDelegationToken, now = Date.now()): boolean {
  if (token.mode === "manual-only" || token.mode === "emergency-stop") return false;
  if (token.revokedAt) return false;
  if (now > token.expiresAt) return false;
  if (typeof token.maxUses === "number" && token.usedCount >= token.maxUses) return false;
  return true;
}
