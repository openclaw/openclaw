import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  type PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import type { ClawAddPlan, ResolvedClawPackage } from "./types.js";

type ClawPackageReceiptOptions = Pick<
  PersistedClawPackageRef,
  "status" | "relationship" | "origin" | "independentOwner"
> & { nowMs?: number };

export function createStatelessClawPackageReceipt(
  plan: ClawAddPlan,
  pkg: ResolvedClawPackage,
  options: ClawPackageReceiptOptions,
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
    status: options.status,
    relationship: options.relationship,
    origin: options.origin,
    independentOwner: options.independentOwner,
    ...(pkg.extension ? { extension: pkg.extension } : {}),
    installedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}
