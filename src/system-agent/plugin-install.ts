import { formatPluginCapabilityConsentLines } from "../cli/plugin-capability-consent.js";
import { resolvePendingPluginCapabilityReview } from "../plugins/capability-consent.js";
import { resolvePluginInstallSourcePlan } from "../plugins/install-source-plan.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SystemAgentOperation } from "./operation-types.js";
import { applyPersistentOperation, type ExecuteOptions } from "./operations-execution-helpers.js";
import type { SystemAgentOperationResult } from "./operations-parse.js";
import {
  redactSystemAgentPluginInstallSpec,
  validateSystemAgentPluginInstallSpec,
} from "./plugin-install-spec.js";

/** Adapt the shared installer to the host's source and capability proposals. */
export async function executeSystemAgentPluginInstall(
  operation: Extract<SystemAgentOperation, { kind: "plugin-install" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  const validationError = validateSystemAgentPluginInstallSpec(operation.spec);
  if (validationError) {
    throw new Error(validationError);
  }
  const plan = resolvePluginInstallSourcePlan({ raw: operation.spec, mode: "install" });
  if (!plan.ok) {
    throw new Error(plan.error);
  }
  try {
    return await applyPersistentOperation({
      auditOperation: "plugin.install",
      operation,
      runtime,
      opts,
      run: async (ctx) => {
        const { installManagedPlugin } = await import("../plugins/management-mutations.js");
        const installed = await ctx.commit(() =>
          installManagedPlugin({
            request: plan.request,
            applyRuntime: ctx.deps?.applyPluginRuntime,
            beforePersistentApply: ctx.assertPersistentApply,
            logger: {
              info: (message) => runtime.log(message),
              warn: (message) => runtime.log(message),
              terminalLinks: false,
            },
            // A retry approves these declarations for this plugin, not whichever
            // capabilities a moving Git branch happens to return next. The source
            // approval trusts its publisher; it is not an exact-byte approval.
            requireCapabilityConsent: Boolean(operation.capabilityReview),
            onCapabilityConsent: async (review) =>
              operation.capabilityReview?.pluginId === review.pluginId &&
              operation.capabilityReview.reviewToken === review.reviewToken
                ? { reviewToken: review.reviewToken }
                : undefined,
          }),
        );
        runtime.log(
          `Installed plugin "${installed.plugin.id}". ${
            installed.application
              ? `Applied in Gateway generation ${installed.application.generation}.`
              : "Saved for the next Gateway start."
          }`,
        );
        for (const warning of installed.warnings ?? []) {
          runtime.log(warning);
        }
        return {
          summary: `Installed plugin ${redactSystemAgentPluginInstallSpec(operation.spec)}`,
          details: {
            spec: redactSystemAgentPluginInstallSpec(operation.spec),
            pluginId: installed.plugin.id,
          },
        };
      },
    });
  } catch (error) {
    if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
      throw error;
    }
    const review = resolvePendingPluginCapabilityReview(error.capabilityConsent.pluginId);
    if (review?.reviewToken !== error.capabilityConsent.reviewToken) {
      throw error;
    }
    const description = formatPluginCapabilityConsentLines(review).join("\n");
    runtime.log(description);
    runtime.log("Nothing was installed. Review these capabilities to continue in this chat.");
    return {
      applied: false,
      pluginCapabilityReview: {
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        description,
      },
    };
  }
}
