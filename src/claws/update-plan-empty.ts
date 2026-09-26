import { CLAW_OUTPUT_STABILITY, type ClawDiagnostic, type ClawSourceIdentity } from "./types.js";
import { summarizeClawUpdatePlan } from "./update-plan-summary.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan-types.js";

export function makeEmptyClawUpdatePlan(params: {
  agentId: string;
  source?: ClawSourceIdentity;
  currentClaw?: ClawUpdatePlan["currentClaw"];
  found?: boolean;
  blockers: ClawDiagnostic[];
  diagnostics?: ClawDiagnostic[];
  digest: (value: unknown) => string;
}): ClawUpdatePlan {
  const plan: Omit<ClawUpdatePlan, "planIntegrity"> = {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: params.found ?? false,
    agentId: params.agentId,
    ...(params.currentClaw ? { currentClaw: params.currentClaw } : {}),
    ...(params.source
      ? {
          targetClaw: {
            name: params.source.name,
            version: params.source.version,
            integrity: params.source.integrity,
          },
        }
      : {}),
    summary: summarizeClawUpdatePlan([], []),
    actions: [],
    capabilityChanges: [],
    readiness: { ready: true, requirements: [] },
    blockers: params.blockers,
    diagnostics: params.diagnostics ?? [],
  };
  return { ...plan, planIntegrity: params.digest(plan) };
}
