import type { PluginAcceptedDeclaredSurface } from "../config/types.plugins.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import type { buildPluginCapabilitySummary } from "../plugins/capability-summary.js";
import type {
  ClawAddPlanAction,
  ClawPluginCapabilityGrantsById,
  ResolvedClawPackage,
} from "./types.js";

export type PlannedClawPackage = ResolvedClawPackage & {
  ownerAction: "install" | "reuse";
  installId?: string;
  riskWarning?: string;
  declaredCapabilities?: PluginAcceptedDeclaredSurface;
  capabilityGrants?: ReturnType<typeof buildPluginCapabilitySummary>["grants"];
  capabilityGrantsByPluginId?: ClawPluginCapabilityGrantsById;
};

export function packageFromAction(action: ClawAddPlanAction): PlannedClawPackage {
  const details = action.details as
    | (Partial<ResolvedClawPackage> & {
        ownerAction?: "install" | "reuse";
        installId?: string;
        riskWarning?: string;
        declaredCapabilities?: PluginAcceptedDeclaredSurface;
        capabilityGrants?: ReturnType<typeof buildPluginCapabilitySummary>["grants"];
        capabilityGrantsByPluginId?: ClawPluginCapabilityGrantsById;
      })
    | undefined;
  if (details?.kind !== "skill" && details?.kind !== "plugin") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no valid package kind.`);
  }
  if (
    details.source !== "clawhub" ||
    !details.ref ||
    !details.version ||
    !details.integrity ||
    !normalizeClawHubSha256Integrity(details.integrity)
  ) {
    throw new Error(
      `Package action ${JSON.stringify(action.id)} is not a pinned ClawHub package with integrity.`,
    );
  }
  if (details.ownerAction !== "install" && details.ownerAction !== "reuse") {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no planned owner state.`);
  }
  if (details.kind === "plugin" && !details.installId) {
    throw new Error(`Package action ${JSON.stringify(action.id)} has no resolved plugin id.`);
  }
  return {
    kind: details.kind,
    source: details.source,
    ref: details.ref,
    version: details.version,
    integrity: details.integrity,
    ownerAction: details.ownerAction,
    ...(details.extension ? { extension: details.extension } : {}),
    ...(details.installId ? { installId: details.installId } : {}),
    ...(details.riskWarning ? { riskWarning: details.riskWarning } : {}),
    ...(details.declaredCapabilities ? { declaredCapabilities: details.declaredCapabilities } : {}),
    ...(details.capabilityGrants ? { capabilityGrants: details.capabilityGrants } : {}),
    ...(details.capabilityGrantsByPluginId
      ? { capabilityGrantsByPluginId: details.capabilityGrantsByPluginId }
      : {}),
  };
}
