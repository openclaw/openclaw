import type { GovdossTenantContext } from "../tenant-context.js";

export type GovdossApiPrincipal = {
  apiKeyId: string;
  tenantId: string;
  subject: string;
  roles: string[];
  scopes: string[];
};

export type GovdossApiAuthResult = {
  ok: boolean;
  principal?: GovdossApiPrincipal;
  tenant?: GovdossTenantContext;
  reason?: string;
};

export function authenticateGovdossApiKey(input: {
  apiKey?: string | null;
  tenant?: GovdossTenantContext | null;
}): GovdossApiAuthResult {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, reason: "missing-api-key" };
  }
  if (!input.tenant) {
    return { ok: false, reason: "missing-tenant-context" };
  }
  return {
    ok: true,
    principal: {
      apiKeyId: apiKey.slice(0, 8),
      tenantId: input.tenant.tenantId,
      subject: `apikey:${apiKey.slice(0, 8)}`,
      roles: ["tenant.operator"],
      scopes: ["execute", "approvals:read", "approvals:write", "usage:read"],
    },
    tenant: input.tenant,
  };
}
