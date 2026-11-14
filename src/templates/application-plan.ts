import { digestTemplateValue } from "./digest.js";
import type {
  TemplateAddCapabilityChange,
  TemplateAddPlanAction,
  TemplateDiagnostic,
  TemplateExtensionPlan,
  TemplateLocalPrerequisite,
  TemplateOpenClawExtension,
  TemplateOpenClawProfile,
  TemplatePackage,
  TemplatePackagePreflight,
  TemplatePackagePreflightResult,
} from "./types.js";

export function templateAddCapabilityChange(
  change: Omit<
    TemplateAddCapabilityChange,
    "classification" | "requiresDistinctConsent" | "digest"
  >,
): TemplateAddCapabilityChange {
  return {
    ...change,
    classification: "escalation",
    requiresDistinctConsent: true,
    digest: digestTemplateValue(change.effect),
  };
}

export function templateAgentCapabilityChange(
  agentId: string,
  settings: TemplateOpenClawProfile["agent"],
): TemplateAddCapabilityChange | undefined {
  const effect = {
    ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
    ...(settings.tools ? { tools: settings.tools } : {}),
    ...(settings.memory ? { memory: settings.memory } : {}),
    ...(settings.heartbeat ? { heartbeat: settings.heartbeat } : {}),
  };
  if (Object.keys(effect).length === 0) {
    return undefined;
  }
  return templateAddCapabilityChange({
    kind: "agent",
    id: agentId,
    path: "agent",
    action: "create",
    reason:
      "The new agent declares sandbox, tool, memory-search, or recurring heartbeat capabilities.",
    effect,
  });
}

function blocker(code: string, path: string, message: string): TemplateDiagnostic {
  return { level: "error", code, phase: "plan", path, message };
}

export function findTemplateExtensionPackageCollisions(params: {
  packages: TemplatePackage[];
  extensions: TemplateOpenClawExtension[];
}): Array<{ index: number; diagnostic: TemplateDiagnostic }> {
  const declaredPackageIds = new Set(params.packages.map((pkg) => `${pkg.kind}:${pkg.ref}`));
  const collisions: Array<{ index: number; diagnostic: TemplateDiagnostic }> = [];

  for (const [index, extension] of params.extensions.entries()) {
    const packageId = `plugin:${extension.ref}`;
    if (declaredPackageIds.has(packageId)) {
      collisions.push({
        index,
        diagnostic: blocker(
          "extension_package_collision",
          `$.profiles.openclaw.extensions[${index}]`,
          `Extension package ${JSON.stringify(packageId)} is already declared by the portable manifest or another profile extension.`,
        ),
      });
      continue;
    }
    declaredPackageIds.add(packageId);
  }

  return collisions;
}

export async function planTemplateExtensions(params: {
  extensions: TemplateOpenClawExtension[];
  workspace: string;
  packagePreflight?: TemplatePackagePreflight;
}): Promise<{
  extensions: TemplateExtensionPlan[];
  actions: TemplateAddPlanAction[];
  capabilityChanges: TemplateAddCapabilityChange[];
  requirements: TemplateLocalPrerequisite[];
  blockers: TemplateDiagnostic[];
}> {
  const extensions: TemplateExtensionPlan[] = [];
  const actions: TemplateAddPlanAction[] = [];
  const capabilityChanges: TemplateAddCapabilityChange[] = [];
  const requirements: TemplateLocalPrerequisite[] = [];
  const blockers: TemplateDiagnostic[] = [];

  for (const [index, extension] of params.extensions.entries()) {
    const preflight: TemplatePackagePreflightResult = params.packagePreflight
      ? await params.packagePreflight(
          {
            kind: "plugin",
            source: extension.source,
            ref: extension.ref,
            version: extension.version,
          },
          params.workspace,
        )
      : {
          ok: false as const,
          code: "package_install_unavailable",
          message: "Extension preflight is unavailable.",
        };
    const completeProvenance =
      preflight.ok &&
      Boolean(
        preflight.integrity &&
        preflight.installId &&
        preflight.action &&
        preflight.detectedFormat &&
        preflight.adapterIdentity &&
        preflight.declaredCapabilities &&
        preflight.capabilityGrants &&
        preflight.capabilityGrantsByPluginId,
      );
    const incompleteProvenance =
      preflight.ok && !completeProvenance
        ? blocker(
            "extension_provenance_incomplete",
            `$.profiles.openclaw.extensions[${index}]`,
            `Extension ${JSON.stringify(extension.id)} did not resolve complete identity and adapter provenance.`,
          )
        : undefined;
    const formatMismatch =
      preflight.ok && completeProvenance && preflight.detectedFormat !== extension.format
        ? blocker(
            "extension_format_mismatch",
            `$.profiles.openclaw.extensions[${index}].format`,
            `Extension ${JSON.stringify(extension.id)} declares format ${JSON.stringify(extension.format)}, but the plugin detector found ${JSON.stringify(preflight.detectedFormat ?? "unknown")}.`,
          )
        : undefined;
    const diagnostic = !preflight.ok
      ? blocker(
          preflight.code ?? "extension_preflight_failed",
          `$.profiles.openclaw.extensions[${index}]`,
          preflight.message ?? "Extension preflight failed.",
        )
      : (incompleteProvenance ?? formatMismatch);
    if (diagnostic) {
      blockers.push(diagnostic);
    }
    if (preflight.ok && preflight.requirements) {
      requirements.push(...preflight.requirements);
    }
    const requirementState: TemplateExtensionPlan["requirementState"] = diagnostic
      ? "conflicting"
      : preflight.action === "install"
        ? "missing-installable"
        : preflight.requirements && preflight.requirements.length > 0
          ? "setup-required"
          : "satisfied";
    const extensionPlan: TemplateExtensionPlan = {
      ...extension,
      ...(preflight.detectedFormat ? { detectedFormat: preflight.detectedFormat } : {}),
      ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
      ...(preflight.installId ? { installId: preflight.installId } : {}),
      ...(preflight.action ? { ownerAction: preflight.action } : {}),
      ...(preflight.declaredCapabilities
        ? { declaredCapabilities: preflight.declaredCapabilities }
        : {}),
      ...(preflight.capabilityGrants ? { capabilityGrants: preflight.capabilityGrants } : {}),
      ...(preflight.capabilityGrantsByPluginId
        ? { capabilityGrantsByPluginId: preflight.capabilityGrantsByPluginId }
        : {}),
      requirementState,
      mapped: preflight.mapped ?? [],
      unavailable: preflight.unavailable ?? [],
      ...(preflight.adapterIdentity ? { adapterIdentity: preflight.adapterIdentity } : {}),
      blocked: Boolean(diagnostic),
    };
    extensions.push(extensionPlan);
    actions.push({
      kind: "package",
      id: `plugin:${extension.ref}`,
      action: preflight.ok && preflight.action === "reuse" ? "reuse" : "install",
      target: `${extension.source}:${extension.ref}@${extension.version}`,
      ...(preflight.integrity ? { digest: preflight.integrity } : {}),
      details: {
        kind: "plugin",
        source: extension.source,
        ref: extension.ref,
        version: extension.version,
        ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
        ...(preflight.installId ? { installId: preflight.installId } : {}),
        ...(preflight.action ? { ownerAction: preflight.action } : {}),
        ...(preflight.declaredCapabilities
          ? { declaredCapabilities: preflight.declaredCapabilities }
          : {}),
        ...(preflight.capabilityGrants ? { capabilityGrants: preflight.capabilityGrants } : {}),
        ...(preflight.capabilityGrantsByPluginId
          ? { capabilityGrantsByPluginId: preflight.capabilityGrantsByPluginId }
          : {}),
        requirementState,
        ...(preflight.requirements ? { prerequisites: preflight.requirements } : {}),
        ...(completeProvenance
          ? {
              extension: {
                id: extension.id,
                format: extension.format,
                detectedFormat: preflight.detectedFormat!,
                mapped: preflight.mapped ?? [],
                unavailable: preflight.unavailable ?? [],
                adapterIdentity: preflight.adapterIdentity!,
              },
            }
          : {}),
        expectedState: !preflight.ok
          ? "unresolved"
          : preflight.action === "reuse"
            ? "present-exact"
            : "absent",
        ...(preflight.warning ? { riskWarning: preflight.warning } : {}),
      },
      blocked: extensionPlan.blocked,
      ...(diagnostic ? { reason: diagnostic.message } : {}),
    });
    const effect = {
      id: extension.id,
      source: extension.source,
      ref: extension.ref,
      version: extension.version,
      expectedFormat: extension.format,
      detectedFormat: preflight.detectedFormat ?? "unresolved",
      integrity: preflight.integrity ?? "unresolved",
      mapped: preflight.mapped ?? [],
      unavailable: preflight.unavailable ?? [],
      adapterIdentity: preflight.adapterIdentity ?? "unresolved",
      declaredCapabilities: preflight.declaredCapabilities ?? {},
      capabilityGrants: preflight.capabilityGrants ?? {},
      capabilityGrantsByPluginId: preflight.capabilityGrantsByPluginId ?? {},
      ...(preflight.installId ? { installId: preflight.installId } : {}),
      ...(preflight.warning ? { riskWarning: preflight.warning } : {}),
    };
    const change = {
      kind: "package" as const,
      id: `extension:${extension.id}`,
      path: `openclaw.extensions.${extension.id}`,
      action: preflight.action === "reuse" ? ("reuse" as const) : ("install" as const),
      reason:
        preflight.action === "reuse"
          ? "The OpenClaw profile requires access to an existing native extension."
          : "The OpenClaw profile requires installation of native extension content or executable code.",
      effect,
    };
    capabilityChanges.push(templateAddCapabilityChange(change));
  }

  return { extensions, actions, capabilityChanges, requirements, blockers };
}
