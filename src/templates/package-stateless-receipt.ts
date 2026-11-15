import {
  TEMPLATE_PACKAGE_REF_SCHEMA_VERSION,
  type PersistedTemplatePackageRef,
} from "./package-extension-provenance.js";
import type { PlannedTemplateBundledDependency } from "./package-plan-action.js";
import type { TemplateAddPlan, ResolvedTemplatePackage } from "./types.js";

type TemplatePackageReceiptOptions = Pick<
  PersistedTemplatePackageRef,
  "status" | "relationship" | "origin" | "independentOwner"
> & { nowMs?: number };

export function createStatelessTemplatePackageReceipt(
  plan: TemplateAddPlan,
  pkg: PlannedTemplateBundledDependency,
  options: TemplatePackageReceiptOptions,
): TemplateBundledPackageReceipt;
export function createStatelessTemplatePackageReceipt(
  plan: TemplateAddPlan,
  pkg: ResolvedTemplatePackage,
  options: TemplatePackageReceiptOptions,
): PersistedTemplatePackageRef;
export function createStatelessTemplatePackageReceipt(
  plan: TemplateAddPlan,
  pkg: ResolvedTemplatePackage | PlannedTemplateBundledDependency,
  options: TemplatePackageReceiptOptions,
): TemplatePackageReceipt {
  if (pkg.source === "bundled") {
    return createBundledTemplatePackageReceipt(plan, pkg, options);
  }
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

export type TemplateBundledPackageReceipt = Omit<
  PersistedTemplatePackageRef,
  "source" | "ref" | "version" | "integrity"
> & {
  source: "bundled";
  path: string;
  name: string;
  installId: string;
  digest: string;
};
export type TemplatePackageReceipt = PersistedTemplatePackageRef | TemplateBundledPackageReceipt;

export function createBundledTemplatePackageReceipt(
  plan: TemplateAddPlan,
  pkg: PlannedTemplateBundledDependency,
  options: TemplatePackageReceiptOptions,
): TemplateBundledPackageReceipt {
  const nowMs = options.nowMs ?? Date.now();
  return {
    schemaVersion: TEMPLATE_PACKAGE_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    templateName: plan.template.name,
    kind: pkg.kind,
    source: "bundled",
    path: pkg.path,
    name: pkg.name,
    installId: pkg.installId,
    digest: pkg.snapshot.digest,
    ...(pkg.extension ? { extension: pkg.extension } : {}),
    status: options.status,
    relationship: options.relationship,
    origin: options.origin,
    independentOwner: options.independentOwner,
    installedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}
