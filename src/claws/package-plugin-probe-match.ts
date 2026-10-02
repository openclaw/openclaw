import { stableStringify } from "@openclaw/normalization-core";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import type { PlannedClawPackage } from "./package-plan-action.js";
import type { probeClawPluginArtifact } from "./plugin-capability-probe.js";

type SuccessfulPluginProbe = Extract<
  Awaited<ReturnType<typeof probeClawPluginArtifact>>,
  { ok: true }
>;
type VerifiedPlannedPlugin = PlannedClawPackage &
  Required<
    Pick<
      PlannedClawPackage,
      "declaredCapabilities" | "capabilityGrants" | "capabilityGrantsByPluginId"
    >
  >;

export function matchesPlannedPluginProbe(
  pkg: PlannedClawPackage,
  probe: SuccessfulPluginProbe,
): pkg is VerifiedPlannedPlugin {
  const probeIntegrity = probe.clawhub.integrity
    ? normalizeClawHubSha256Integrity(probe.clawhub.integrity)
    : null;
  const plannedExtensionInspection = pkg.extension
    ? {
        detectedFormat: pkg.extension.detectedFormat,
        mapped: pkg.extension.mapped,
        unavailable: pkg.extension.unavailable,
        adapterIdentity: pkg.extension.adapterIdentity,
      }
    : undefined;
  const probedExtensionInspection = probe.artifactInspection
    ? {
        detectedFormat: probe.artifactInspection.format,
        mapped: probe.artifactInspection.mapped,
        unavailable: probe.artifactInspection.unavailable,
        adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
      }
    : undefined;
  return (
    probe.pluginId === pkg.installId &&
    probeIntegrity === normalizeClawHubSha256Integrity(pkg.integrity) &&
    probe.warning === pkg.riskWarning &&
    Boolean(pkg.declaredCapabilities) &&
    stableStringify(probe.declaredCapabilities) === stableStringify(pkg.declaredCapabilities) &&
    Boolean(pkg.capabilityGrants) &&
    stableStringify(probe.capabilityGrants) === stableStringify(pkg.capabilityGrants) &&
    Boolean(pkg.capabilityGrantsByPluginId) &&
    stableStringify(probe.capabilityGrantsByPluginId) ===
      stableStringify(pkg.capabilityGrantsByPluginId) &&
    (!plannedExtensionInspection ||
      stableStringify(probedExtensionInspection) === stableStringify(plannedExtensionInspection))
  );
}
