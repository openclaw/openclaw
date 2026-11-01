import { listAgentIds } from "../agents/agent-scope.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import { detectSkillWorkshopToolPolicyDiagnostic } from "../skills/workshop/tool-policy-diagnostic.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthFinding } from "./health-checks.js";

const SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID = "core/doctor/skill-workshop-tool-policy";

/** Skill Workshop needs its review tool and the skill-workshop plugin that loads learned skills. */
export const skillWorkshopToolPolicyCheck: Omit<DoctorHealthCheck, "kind" | "source"> = {
  id: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
  description: "Autonomous Skill Workshop capture has a callable review tool.",
  async detect(ctx) {
    const workshopEnabled = resolveSkillWorkshopConfig(ctx.cfg).autonomous.mode !== "off";
    const listedAgentIds = listAgentIds(ctx.cfg);
    const diagnostics = (listedAgentIds.length > 0 ? listedAgentIds : [undefined]).flatMap(
      (agentId) => {
        const diagnostic = detectSkillWorkshopToolPolicyDiagnostic({
          config: ctx.cfg,
          workshopEnabled,
          ...(agentId ? { agentId } : {}),
        });
        return diagnostic ? [diagnostic] : [];
      },
    );
    // Learned skills load through the skill-workshop plugin; these switches keep it off.
    const plugins = ctx.cfg.plugins;
    const allowlistExcludes =
      Array.isArray(plugins?.allow) &&
      plugins.allow.length > 0 &&
      !plugins.allow.some((id) => id.trim().toLowerCase() === "skill-workshop");
    const pluginOff = workshopEnabled && (plugins?.enabled === false || allowlistExcludes);
    const pluginFinding: HealthFinding[] = pluginOff
      ? [
          {
            checkId: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
            category: "fix-now",
            docsUrl: "https://docs.openclaw.ai/tools/skill-workshop",
            severity: "warning",
            message: `Skill Workshop is on, but ${plugins?.enabled === false ? "plugins.enabled=false" : "plugins.allow"} keeps the skill-workshop plugin off, so learned skills are not loaded.`,
            path: plugins?.enabled === false ? "plugins.enabled" : "plugins.allow",
            requirement: "Learned skills load through the skill-workshop plugin.",
            fixHint:
              plugins?.enabled === false
                ? "Enable plugins and limit them with plugins.allow, including skill-workshop."
                : 'Add "skill-workshop" to plugins.allow.',
          },
        ]
      : [];
    const policyFindings: HealthFinding[] = diagnostics.map((diagnostic) => ({
      checkId: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
      category: "fix-now",
      docsUrl: "https://docs.openclaw.ai/tools/skill-workshop",
      severity: "warning",
      message: diagnostic.detail,
      path: diagnostic.source,
      target: diagnostic.agentId,
      requirement: "Autonomous Skill Workshop review requires the skill_workshop tool.",
      fixHint: diagnostic.fix,
    }));
    return [...pluginFinding, ...policyFindings];
  },
};
