import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  type persistClawPackageRef,
  type PersistedClawPackageRef,
} from "./provenance.js";

export function createStatelessClawPackageReceipt(
  plan: Parameters<typeof persistClawPackageRef>[0],
  pkg: Parameters<typeof persistClawPackageRef>[1],
  options: Parameters<typeof persistClawPackageRef>[2] = {},
): PersistedClawPackageRef {
  const nowMs = options.nowMs ?? Date.now();
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    clawName: plan.claw.name,
    kind: pkg.kind,
    source: pkg.source,
    ref: pkg.ref,
    version: pkg.version,
    integrity: pkg.integrity,
    status: options.status ?? "complete",
    relationship: options.relationship ?? (pkg.kind === "skill" ? "managed" : "referenced"),
    origin: options.origin ?? "claw-introduced",
    independentOwner: options.independentOwner ?? false,
    ...(pkg.extension ? { extension: pkg.extension } : {}),
    installedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}
