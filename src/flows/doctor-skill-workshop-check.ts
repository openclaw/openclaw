import { listAgentIds } from "../agents/agent-scope.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import {
  detectSkillWorkshopExperienceReviewRuntimeDiagnostic,
  detectSkillWorkshopToolPolicyDiagnostic,
} from "../skills/workshop/tool-policy-diagnostic.js";
import type { HealthCheck } from "./health-checks.js";

const CHECK_ID = "core/doctor/skill-workshop-tool-policy";

export const skillWorkshopToolPolicyCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  description: "Autonomous Skill Workshop review has a supported runtime and callable tool.",
  source: "doctor",
  async detect(ctx) {
    const workshopEnabled = resolveSkillWorkshopConfig(ctx.cfg).autonomous.mode !== "off";
    const listedAgentIds = listAgentIds(ctx.cfg);
    const diagnostics = (listedAgentIds.length > 0 ? listedAgentIds : [undefined]).flatMap(
      (agentId) => {
        const params = {
          config: ctx.cfg,
          workshopEnabled,
          ...(agentId ? { agentId } : {}),
        };
        return [
          detectSkillWorkshopToolPolicyDiagnostic(params),
          detectSkillWorkshopExperienceReviewRuntimeDiagnostic(params),
        ].filter((diagnostic) => diagnostic !== null);
      },
    );
    return diagnostics.map((diagnostic) => ({
      checkId: CHECK_ID,
      severity: "warning",
      message: diagnostic.detail,
      path: diagnostic.source,
      target: diagnostic.agentId,
      requirement:
        diagnostic.requirement ??
        "Autonomous Skill Workshop review requires the skill_workshop tool.",
      fixHint: diagnostic.fix,
    }));
  },
};
