import type { OpenClawConfig } from "../config/types.openclaw.js";
import { templateAddCapabilityChange } from "./application-plan.js";
import type { TemplateDirectorySnapshot } from "./dependency-directory.js";
import { preflightTemplatePackage } from "./package-preflight.js";
import { templateManifestWorkspaceConflictsWithPath } from "./schema.js";
import type {
  TemplateAddPlanAction,
  TemplateBundledDependency,
  TemplateDiagnostic,
  TemplateManifest,
  TemplatePackagePreflight,
} from "./types.js";

/** Bind local dependency identity, native preflight and destination ownership to one reviewed action. */
export async function planBundledTemplateDependency(params: {
  dependency: TemplateBundledDependency;
  manifest: TemplateManifest;
  declarationPath: string;
  packageRoot: string;
  workspace: string;
  snapshot?: TemplateDirectorySnapshot;
  config?: OpenClawConfig;
  packagePreflight?: TemplatePackagePreflight;
  skillNames: Set<string>;
  skillTargets: Set<string>;
  referencedSkillTargets: ReadonlySet<string>;
}) {
  const { dependency, workspace, packageRoot, snapshot } = params;
  const preflight = params.packagePreflight
    ? await params.packagePreflight(dependency, workspace, { packageRoot, snapshot })
    : await preflightTemplatePackage(dependency, workspace, {
        packageRoot,
        snapshot,
        config: params.config,
      });
  const collision =
    dependency.kind === "skill" &&
    preflight.installId &&
    (params.referencedSkillTargets.has(preflight.installId.toLowerCase()) ||
      params.skillTargets.has(preflight.installId.toLowerCase()) ||
      (preflight.name && params.skillNames.has(preflight.name.normalize("NFC").toLowerCase())) ||
      templateManifestWorkspaceConflictsWithPath(params.manifest, `skills/${preflight.installId}`));
  const blocked =
    !preflight.ok ||
    !preflight.snapshot ||
    !preflight.name ||
    !preflight.installId ||
    Boolean(collision);
  if (dependency.kind === "skill") {
    if (preflight.name) {
      params.skillNames.add(preflight.name.normalize("NFC").toLowerCase());
    }
    if (preflight.installId) {
      params.skillTargets.add(preflight.installId.toLowerCase());
    }
  }
  const diagnostic: TemplateDiagnostic | undefined = blocked
    ? {
        level: "error",
        phase: "plan",
        path: params.declarationPath,
        code: collision
          ? "bundled_skill_collision"
          : (preflight.code ?? "bundled_dependency_invalid"),
        message: collision
          ? "Bundled skill identity or destination conflicts with another declaration."
          : (preflight.message ?? "Bundled dependency identity is incomplete."),
      }
    : undefined;
  const action: TemplateAddPlanAction = {
    kind: "package",
    id: `${dependency.kind}:bundled:${dependency.path}`,
    action: preflight.action === "reuse" ? "reuse" : "install",
    target: `bundled:${dependency.path}`,
    digest: preflight.snapshot?.digest,
    blocked,
    details: {
      ...dependency,
      name: preflight.name,
      installId: preflight.installId,
      snapshot: preflight.snapshot,
      ownerAction: preflight.action ?? "install",
      requirementState: blocked
        ? "conflicting"
        : preflight.action === "reuse"
          ? "satisfied"
          : "missing-installable",
      ...(preflight.warning ? { riskWarning: preflight.warning } : {}),
      ...(preflight.installPolicyWarningDigest
        ? { installPolicyWarningDigest: preflight.installPolicyWarningDigest }
        : {}),
      ...(preflight.declaredCapabilities
        ? { declaredCapabilities: preflight.declaredCapabilities }
        : {}),
      ...(preflight.capabilityGrants ? { capabilityGrants: preflight.capabilityGrants } : {}),
      ...(preflight.capabilityGrantsByPluginId
        ? { capabilityGrantsByPluginId: preflight.capabilityGrantsByPluginId }
        : {}),
      ...(preflight.installId && preflight.detectedFormat && preflight.adapterIdentity
        ? {
            extension: {
              id: preflight.installId,
              format: preflight.detectedFormat,
              detectedFormat: preflight.detectedFormat,
              mapped: preflight.mapped ?? [],
              unavailable: preflight.unavailable ?? [],
              adapterIdentity: preflight.adapterIdentity,
            },
          }
        : {}),
      ...(preflight.requirements ? { prerequisites: preflight.requirements } : {}),
    },
  };
  return {
    action,
    diagnostic,
    requirements: preflight.ok ? (preflight.requirements ?? []) : [],
    capabilityChange: templateAddCapabilityChange({
      kind: "package",
      id: action.id,
      path: `${dependency.kind === "skill" ? "skills" : "plugins"}.${dependency.path}`,
      action: action.action === "reuse" ? "reuse" : "install",
      reason: "The Template includes bundled dependency content.",
      effect: {
        ...dependency,
        name: preflight.name ?? dependency.path,
        digest: preflight.snapshot?.digest ?? "unresolved",
      },
    }),
  };
}
