import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import type { ClawPackagePreflight } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan-types.js";

export function updatePackagePreflight(
  plan: ClawUpdatePlan,
  packagePreflight?: ClawPackagePreflight,
): ClawPackagePreflight {
  return async (pkg, workspace) => {
    const preflight = packagePreflight
      ? await packagePreflight(pkg, workspace)
      : {
          ok: false,
          code: "package_install_unavailable",
          message: "Package preflight is unavailable.",
        };
    const action = plan.actions.find(
      (candidate) => candidate.kind === "package" && candidate.id === `${pkg.kind}:${pkg.ref}`,
    );
    return !preflight.ok &&
      action?.action === "change" &&
      ((pkg.kind === "plugin" && preflight.code === "plugin_version_conflict") ||
        (pkg.kind === "skill" &&
          preflight.code === "skill_version_conflict" &&
          preflight.integrity &&
          normalizeClawHubSha256Integrity(preflight.integrity)))
      ? {
          ok: true,
          action: "install" as const,
          ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
          ...(preflight.installId ? { installId: preflight.installId } : {}),
          ...(preflight.warning ? { warning: preflight.warning } : {}),
          ...(preflight.declaredCapabilities
            ? { declaredCapabilities: preflight.declaredCapabilities }
            : {}),
          ...(preflight.capabilityGrants ? { capabilityGrants: preflight.capabilityGrants } : {}),
          ...(preflight.capabilityGrantsByPluginId
            ? { capabilityGrantsByPluginId: preflight.capabilityGrantsByPluginId }
            : {}),
          ...(preflight.requirements ? { requirements: preflight.requirements } : {}),
          ...(preflight.detectedFormat ? { detectedFormat: preflight.detectedFormat } : {}),
          ...(preflight.mapped ? { mapped: preflight.mapped } : {}),
          ...(preflight.unavailable ? { unavailable: preflight.unavailable } : {}),
          ...(preflight.adapterIdentity ? { adapterIdentity: preflight.adapterIdentity } : {}),
        }
      : preflight;
  };
}
