import { Value } from "typebox/value";
import {
  PluginDeclaredSurfaceSchema,
  PluginOperatorGrantsSchema,
  type PluginOperatorGrants,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { PluginAcceptedDeclaredSurface } from "../config/types.plugins.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import type { ClawAddPlan } from "./types.js";

export type ClawPluginCapabilityPlanReview = {
  actionId: string;
  pluginId: string;
  ref: string;
  version: string;
  ownerAction: "install" | "reuse";
  integrity: string;
  declaredCapabilities: PluginAcceptedDeclaredSurface;
  capabilityGrants: PluginOperatorGrants;
  reviewToken: string;
  riskWarning?: string;
};

/** Project only facts already bound to the Add plan's integrity digest. */
export function projectClawPluginCapabilityReviews(
  plan: ClawAddPlan,
): ClawPluginCapabilityPlanReview[] {
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
      typeof details.ref !== "string" ||
      typeof details.version !== "string" ||
      !integrity ||
      (details.ownerAction !== "install" && details.ownerAction !== "reuse") ||
      !Value.Check(PluginDeclaredSurfaceSchema, details.declaredCapabilities) ||
      !Value.Check(PluginOperatorGrantsSchema, details.capabilityGrants)
    ) {
      throw new Error(`Plugin action ${JSON.stringify(action.id)} has incomplete review evidence.`);
    }
    const declaredCapabilities = details.declaredCapabilities;
    return [
      {
        actionId: action.id,
        pluginId: details.installId,
        ref: details.ref,
        version: details.version,
        ownerAction: details.ownerAction,
        integrity,
        declaredCapabilities,
        capabilityGrants: details.capabilityGrants,
        reviewToken: computeDeclaredSurfaceHash(declaredCapabilities),
        ...(typeof details.riskWarning === "string" ? { riskWarning: details.riskWarning } : {}),
      },
    ];
  });
}
