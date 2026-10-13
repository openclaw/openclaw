/** Validates and normalizes provider plugin definitions before registry registration. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  omitUndefinedManifestFields,
  optionalManifestFields,
} from "./manifest-capability-normalizers.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

type ProviderWizardSetup = NonNullable<NonNullable<ProviderPlugin["wizard"]>["setup"]>;
type ProviderWizardModelPicker = NonNullable<NonNullable<ProviderPlugin["wizard"]>["modelPicker"]>;
type ProviderWizardModelAllowlist = NonNullable<ProviderWizardSetup["modelAllowlist"]>;

function normalizeTextList(values: string[] | undefined): string[] | undefined {
  const normalized = normalizeUniqueTrimmedStringList(values);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOnboardingScopes(
  values: Array<"text-inference" | "image-generation" | "music-generation"> | undefined,
): Array<"text-inference" | "image-generation" | "music-generation"> | undefined {
  const normalized = Array.from(
    new Set(
      (values ?? []).filter(
        (value): value is "text-inference" | "image-generation" | "music-generation" =>
          value === "text-inference" ||
          value === "image-generation" ||
          value === "music-generation",
      ),
    ),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderOAuthProfileIdRepairs(
  values: ProviderPlugin["oauthProfileIdRepairs"],
): ProviderPlugin["oauthProfileIdRepairs"] {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values
    .map((value) => {
      const legacyProfileId = normalizeOptionalString(value?.legacyProfileId);
      const promptLabel = normalizeOptionalString(value?.promptLabel);
      if (!legacyProfileId && !promptLabel) {
        return null;
      }
      return {
        ...(legacyProfileId ? { legacyProfileId } : {}),
        ...(promptLabel ? { promptLabel } : {}),
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function buildNormalizedModelAllowlist(
  modelAllowlist: ProviderWizardModelAllowlist | undefined,
): ProviderWizardModelAllowlist | undefined {
  if (!modelAllowlist) {
    return undefined;
  }
  return optionalManifestFields({
    allowedKeys: normalizeTextList(modelAllowlist.allowedKeys),
    initialSelections: normalizeTextList(modelAllowlist.initialSelections),
    loadCatalog: modelAllowlist.loadCatalog === true ? true : undefined,
    message: normalizeOptionalString(modelAllowlist.message),
  });
}

function buildNormalizedWizardSetup(
  setup: ProviderWizardSetup,
  methodId: string | undefined,
): ProviderWizardSetup {
  return omitUndefinedManifestFields({
    choiceId: normalizeOptionalString(setup.choiceId),
    modelTarget: setup.modelTarget === "utility" ? ("utility" as const) : undefined,
    choiceLabel: normalizeOptionalString(setup.choiceLabel),
    choiceHint: normalizeOptionalString(setup.choiceHint),
    assistantPriority:
      typeof setup.assistantPriority === "number" && Number.isFinite(setup.assistantPriority)
        ? setup.assistantPriority
        : undefined,
    assistantVisibility:
      setup.assistantVisibility === "manual-only" ||
      setup.assistantVisibility === "visible" ||
      setup.assistantVisibility === "detected-only"
        ? setup.assistantVisibility
        : undefined,
    onboardingFeatured: setup.onboardingFeatured === true ? true : undefined,
    groupId: normalizeOptionalString(setup.groupId),
    groupLabel: normalizeOptionalString(setup.groupLabel),
    groupHint: normalizeOptionalString(setup.groupHint),
    methodId,
    onboardingScopes: normalizeOnboardingScopes(setup.onboardingScopes),
    modelAllowlist: buildNormalizedModelAllowlist(setup.modelAllowlist),
    modelSelection: optionalManifestFields({
      promptWhenAuthChoiceProvided:
        typeof setup.modelSelection?.promptWhenAuthChoiceProvided === "boolean"
          ? setup.modelSelection.promptWhenAuthChoiceProvided
          : undefined,
      allowKeepCurrent:
        typeof setup.modelSelection?.allowKeepCurrent === "boolean"
          ? setup.modelSelection.allowKeepCurrent
          : undefined,
    }),
  });
}

function buildNormalizedModelPicker(
  modelPicker: ProviderWizardModelPicker,
  methodId: string | undefined,
): ProviderWizardModelPicker {
  return omitUndefinedManifestFields({
    label: normalizeOptionalString(modelPicker.label),
    hint: normalizeOptionalString(modelPicker.hint),
    methodId,
  });
}

/** Normalizes provider plugin metadata and emits diagnostics for invalid public fields. */
export function normalizeRegisteredProvider(params: {
  pluginId: string;
  source: string;
  provider: ProviderPlugin;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderPlugin | null {
  const diagnose = (level: PluginDiagnostic["level"], message: string) =>
    params.pushDiagnostic({ level, pluginId: params.pluginId, source: params.source, message });
  const id = normalizeOptionalString(params.provider.id);
  if (!id) {
    diagnose("error", "provider registration missing id");
    return null;
  }
  function normalizeWizardSurface<T extends { methodId?: string }>(
    surface: T | undefined,
    metadataKind: "setup" | "model-picker",
    project: (surface: T, methodId: string | undefined) => T,
    methodIds: ReadonlySet<string>,
  ): T | undefined {
    if (!surface) {
      return undefined;
    }
    if (methodIds.size === 0) {
      diagnose(
        "warn",
        `provider "${id}" ${metadataKind} metadata ignored because it has no auth methods`,
      );
      return undefined;
    }
    let methodId = normalizeOptionalString(surface.methodId);
    if (methodId && !methodIds.has(methodId)) {
      diagnose(
        "warn",
        `provider "${id}" ${metadataKind} method "${methodId}" not found; falling back to available methods`,
      );
      methodId = undefined;
    }
    return project(surface, methodId);
  }

  const seenMethodIds = new Set<string>();
  const auth: ProviderAuthMethod[] = [];
  for (const method of params.provider.auth ?? []) {
    const methodId = normalizeOptionalString(method.id);
    if (!methodId) {
      diagnose("error", `provider "${id}" auth method missing id`);
      continue;
    }
    if (seenMethodIds.has(methodId)) {
      diagnose("error", `provider "${id}" auth method duplicated id "${methodId}"`);
      continue;
    }
    seenMethodIds.add(methodId);
    const wizard = normalizeWizardSurface(
      method.wizard,
      "setup",
      buildNormalizedWizardSetup,
      new Set([methodId]),
    );
    const hint = normalizeOptionalString(method.hint);
    auth.push({
      ...method,
      id: methodId,
      label: normalizeOptionalString(method.label) ?? methodId,
      ...(hint ? { hint } : {}),
      ...(wizard ? { wizard } : {}),
    });
  }
  const docsPath = normalizeOptionalString(params.provider.docsPath);
  const aliases = normalizeTextList(params.provider.aliases);
  const deprecatedProfileIds = normalizeTextList(params.provider.deprecatedProfileIds);
  const oauthProfileIdRepairs = normalizeProviderOAuthProfileIdRepairs(
    params.provider.oauthProfileIdRepairs,
  );
  const envVars = normalizeTextList(params.provider.envVars);
  const setup = normalizeWizardSurface(
    params.provider.wizard?.setup,
    "setup",
    buildNormalizedWizardSetup,
    seenMethodIds,
  );
  const modelPicker = normalizeWizardSurface(
    params.provider.wizard?.modelPicker,
    "model-picker",
    buildNormalizedModelPicker,
    seenMethodIds,
  );
  const catalog = params.provider.catalog;
  const {
    wizard: _ignoredWizard,
    docsPath: _ignoredDocsPath,
    aliases: _ignoredAliases,
    envVars: _ignoredEnvVars,
    catalog: _ignoredCatalog,
    ...restProvider
  } = params.provider;
  return {
    ...restProvider,
    id,
    label: normalizeOptionalString(params.provider.label) ?? id,
    ...(docsPath ? { docsPath } : {}),
    ...(aliases ? { aliases } : {}),
    ...(deprecatedProfileIds ? { deprecatedProfileIds } : {}),
    ...(oauthProfileIdRepairs ? { oauthProfileIdRepairs } : {}),
    ...(envVars ? { envVars } : {}),
    auth,
    ...(catalog ? { catalog } : {}),
    ...(setup || modelPicker
      ? { wizard: { ...(setup ? { setup } : {}), ...(modelPicker ? { modelPicker } : {}) } }
      : {}),
  };
}
