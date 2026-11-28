import type { StatelessTemplateAddResult } from "./add-stateless-contract.js";

export type TemplateAddOutcomes = {
  packages: Array<{
    kind: string;
    id: string;
    status: string;
    relationship: string;
    origin: string;
  }>;
  mcpServers: Array<{ name: string; status: string; relationship: string; origin: string }>;
  automations: Array<{
    declarationId: string;
    schedulerJobId?: string;
    status: string;
    enabled?: boolean;
  }>;
};

/** Outcome shared by reviewed and chat-based Gateway Template Add. */
export type GatewayTemplateAddApplyResult = {
  agentId: string;
  workspace?: string;
  /** Operation receipts, not inferred from the proposed plan. Absent on early failure. */
  outcomes?: TemplateAddOutcomes;
  status: "complete" | "partial";
  agentRetained?: true;
  initializationPending?: true;
  sessionKey?: string;
  readiness: { ready: boolean; requirements: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

/** Disclose actual operation receipts without prompts, credentials or internal owner facts. */
export function projectTemplateAddOutcomes(
  result: StatelessTemplateAddResult,
): TemplateAddOutcomes {
  return {
    packages: result.packages.map((pkg) => ({
      kind: pkg.kind,
      id: pkg.source === "bundled" ? pkg.installId : pkg.ref,
      status: pkg.status,
      relationship: pkg.relationship,
      origin: pkg.origin,
    })),
    mcpServers: result.mcpServers.map(({ name, status, relationship, origin }) => ({
      name,
      status,
      relationship,
      origin,
    })),
    automations: result.cronJobs.map(({ manifestId, schedulerJobId, status, job }) => ({
      declarationId: manifestId,
      ...(schedulerJobId ? { schedulerJobId } : {}),
      status,
      ...(status === "complete" && schedulerJobId
        ? {
            enabled: "automation" in job ? (job.automation.enabled ?? true) : (job.enabled ?? true),
          }
        : {}),
    })),
  };
}
