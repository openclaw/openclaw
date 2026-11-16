import { Value } from "typebox/value";
import {
  PluginDeclaredSurfaceSchema,
  PluginOperatorGrantsSchema,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { TemplatePluginGrantsByIdSchema } from "../../packages/gateway-protocol/src/schema/templates.js";
import type { TemplatePluginReview } from "../../packages/gateway-protocol/src/schema/templates.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import type { TemplateAddPlan } from "./types.js";

export type TemplatePluginCapabilityPlanReview = TemplatePluginReview;

/** Project only facts already bound to the Add plan's integrity digest. */
export function projectTemplatePluginCapabilityReviews(
  plan: TemplateAddPlan,
): TemplatePluginCapabilityPlanReview[] {
  return plan.actions.flatMap((action) => {
    if (action.kind !== "package" || action.details?.kind !== "plugin" || action.blocked) {
      return [];
    }
    const details = action.details;
    const integrity =
      typeof details.integrity === "string"
        ? normalizeClawHubSha256Integrity(details.integrity)
        : null;
    if (
      typeof details.installId !== "string" ||
      (details.ownerAction !== "install" && details.ownerAction !== "reuse") ||
      !Value.Check(PluginDeclaredSurfaceSchema, details.declaredCapabilities) ||
      !Value.Check(PluginOperatorGrantsSchema, details.capabilityGrants) ||
      !Value.Check(TemplatePluginGrantsByIdSchema, details.capabilityGrantsByPluginId) ||
      Object.keys(details.capabilityGrantsByPluginId).length === 0
    ) {
      throw new Error(`Plugin action ${JSON.stringify(action.id)} has incomplete review evidence.`);
    }
    let source:
      | Pick<
          Extract<TemplatePluginReview, { source: "clawhub" }>,
          "source" | "ref" | "version" | "integrity"
        >
      | Pick<Extract<TemplatePluginReview, { source: "bundled" }>, "source" | "path" | "digest">;
    if (
      details.source === "bundled" &&
      typeof details.path === "string" &&
      typeof action.digest === "string"
    ) {
      source = { source: "bundled", path: details.path, digest: action.digest };
    } else if (
      details.source === "clawhub" &&
      typeof details.ref === "string" &&
      typeof details.version === "string" &&
      integrity
    ) {
      source = { source: "clawhub", ref: details.ref, version: details.version, integrity };
    } else {
      throw new Error(`Plugin action ${JSON.stringify(action.id)} has incomplete review evidence.`);
    }
    const declaredCapabilities = details.declaredCapabilities;
    return [
      {
        actionId: action.id,
        pluginId: details.installId,
        ...source,
        ownerAction: details.ownerAction,
        declaredCapabilities,
        capabilityGrants: details.capabilityGrants,
        capabilityGrantsByPluginId: details.capabilityGrantsByPluginId,
        reviewToken: computeDeclaredSurfaceHash(declaredCapabilities),
        ...(typeof details.riskWarning === "string" ? { riskWarning: details.riskWarning } : {}),
      },
    ];
  });
}
