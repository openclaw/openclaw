import {
  TEMPLATE_PACKAGE_REF_SCHEMA_VERSION,
  type PersistedTemplatePackageRef,
} from "./package-extension-provenance.js";
import type { TemplateAddPlan, ResolvedTemplatePackage } from "./types.js";

type TemplatePackageReceiptOptions = Pick<
  PersistedTemplatePackageRef,
  "status" | "relationship" | "origin" | "independentOwner"
> & { nowMs?: number };

export function createStatelessTemplatePackageReceipt(
  plan: TemplateAddPlan,
  pkg: ResolvedTemplatePackage,
  options: TemplatePackageReceiptOptions,
): PersistedTemplatePackageRef {
  const nowMs = options.nowMs ?? Date.now();
  return {
    schemaVersion: TEMPLATE_PACKAGE_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    templateName: plan.template.name,
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
