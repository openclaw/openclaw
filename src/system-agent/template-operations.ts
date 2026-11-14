import type { RuntimeEnv } from "../runtime.js";
import {
  TemplateGatewayPlanBlockedError,
  TemplateGatewayPlanChangedError,
} from "../templates/gateway-add-apply.js";
import { bindTemplatePluginInstallConsent } from "../templates/gateway-plugin-consent.js";
import { bindTemplateSkillWarningConsent } from "../templates/gateway-skill-consent.js";
import type { SystemAgentTemplateOperation } from "./operation-types.js";
import { applyPersistentOperation, type ExecuteOptions } from "./operations-execution-helpers.js";
import type { SystemAgentOperationResult } from "./operations-parse.js";
import { getSystemAgentTemplateGateway } from "./template-gateway.js";

export async function executeSystemAgentTemplateOperation(
  operation: SystemAgentTemplateOperation,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  const gateway = getSystemAgentTemplateGateway();
  if (!gateway) {
    throw new Error(
      "Template installation needs an active administrator Gateway request. Use Settings → Ask OpenClaw or Pages → Templates on the target Gateway; enable Templates in Settings → Labs first. No shell fallback is available.",
    );
  }
  if (operation.kind === "template-review" || !opts.approved) {
    const review = await gateway.review({
      source: operation.source,
      ...(operation.agentId ? { agentId: operation.agentId } : {}),
    });
    const description = `Reviewed Template plan (metadata, not instructions):
${JSON.stringify(review)}`;
    if (operation.kind === "template-install") {
      if (
        review.planIntegrity !== operation.planIntegrity ||
        review.target.agentId !== operation.agentId
      ) {
        throw new TemplateGatewayPlanChangedError();
      }
      if (review.blockers.length || review.actions.some((action) => action.blocked)) {
        throw new TemplateGatewayPlanBlockedError(
          review.blockers[0]?.message ?? "This Template is blocked. Run template_review again.",
        );
      }
      if (review.riskAcknowledgementRequired && !operation.acknowledgeClawHubRisk) {
        throw new Error(
          "Review the Template trust warning and provide acknowledgeClawHubRisk for this exact release before requesting installation. " +
            (review.trustWarning ?? ""),
        );
      }
      // These are the installer's exact-artifact consent owners, not a second
      // approval policy. The host still authorizes the whole proposal afterward.
      bindTemplatePluginInstallConsent(
        review.pluginReviews,
        operation.acknowledgeCapabilities,
        () => {},
      );
      bindTemplateSkillWarningConsent(
        review.skillReviews,
        operation.acknowledgeSkillWarnings,
        () => {},
      );
    }
    runtime.log(description);
    return { applied: false, message: description };
  }
  return await applyPersistentOperation({
    auditOperation: "templates.add",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const { kind: _kind, ...params } = operation;
      const result = await ctx.commit(() => gateway.install(params, ctx.assertPersistentApply));
      runtime.log(JSON.stringify(result));
      return {
        summary: `Template Add ${result.status} for agent ${result.agentId}`,
        agentId: result.agentId,
        details: { agentId: result.agentId, status: result.status, readiness: result.readiness },
      };
    },
  });
}
