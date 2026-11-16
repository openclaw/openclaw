import type { StatelessTemplateAddResult } from "./add-stateless.js";

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
