/** Validates and normalizes provider plugin definitions before registry registration. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

type ProviderWizardSetup = NonNullable<NonNullable<ProviderPlugin["wizard"]>["setup"]>;
type ProviderWizardModelPicker = NonNullable<NonNullable<ProviderPlugin["wizard"]>["modelPicker"]>;
type ProviderWizardModelAllowlist = NonNullable<ProviderWizardSetup["modelAllowlist"]>;
type ProviderValidationContext = {
  providerId: string;
  pluginId: string;
  source: string;
  auth: ProviderAuthMethod[];
  pushDiagnostic: (diag: PluginDiagnostic) => void;
};

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

function resolveWizardMethodId(
  params: ProviderValidationContext & {
    methodId: string | undefined;
    metadataKind: "setup" | "model-picker";
  },
): string | undefined {
  if (!params.methodId) {
    return undefined;
  }
  if (params.auth.some((method) => method.id === params.methodId)) {
    return params.methodId;
  }
  params.pushDiagnostic({
    level: "warn",
    pluginId: params.pluginId,
    source: params.source,
    message: `provider "${params.providerId}" ${params.metadataKind} method "${params.methodId}" not found; falling back to available methods`,
  });
  return undefined;
}

function buildNormalizedModelAllowlist(
  modelAllowlist: ProviderWizardModelAllowlist | undefined,
): ProviderWizardModelAllowlist | undefined {
  if (!modelAllowlist) {
    return undefined;
  }
  const allowedKeys = normalizeTextList(modelAllowlist.allowedKeys);
  const initialSelections = normalizeTextList(modelAllowlist.initialSelections);
  const loadCatalog = modelAllowlist.loadCatalog === true;
  const message = normalizeOptionalString(modelAllowlist.message);
  if (!allowedKeys && !initialSelections && !loadCatalog && !message) {
    return undefined;
  }
  return {
    ...(allowedKeys ? { allowedKeys } : {}),
    ...(initialSelections ? { initialSelections } : {}),
    ...(loadCatalog ? { loadCatalog } : {}),
    ...(message ? { message } : {}),
  };
}

function buildNormalizedWizardSetup(
  setup: ProviderWizardSetup,
  methodId: string | undefined,
): ProviderWizardSetup {
  const choiceId = normalizeOptionalString(setup.choiceId);
  const choiceLabel = normalizeOptionalString(setup.choiceLabel);
  const choiceHint = normalizeOptionalString(setup.choiceHint);
  const groupId = normalizeOptionalString(setup.groupId);
  const groupLabel = normalizeOptionalString(setup.groupLabel);
  const groupHint = normalizeOptionalString(setup.groupHint);
  const onboardingScopes = normalizeOnboardingScopes(setup.onboardingScopes);
  const modelAllowlist = buildNormalizedModelAllowlist(setup.modelAllowlist);
  const modelSelection = {
    ...(typeof setup.modelSelection?.promptWhenAuthChoiceProvided === "boolean"
      ? { promptWhenAuthChoiceProvided: setup.modelSelection.promptWhenAuthChoiceProvided }
      : {}),
    ...(typeof setup.modelSelection?.allowKeepCurrent === "boolean"
      ? { allowKeepCurrent: setup.modelSelection.allowKeepCurrent }
      : {}),
  };
  return {
    ...(choiceId ? { choiceId } : {}),
    ...(setup.modelTarget === "utility" ? { modelTarget: "utility" as const } : {}),
    ...(choiceLabel ? { choiceLabel } : {}),
    ...(choiceHint ? { choiceHint } : {}),
    ...(typeof setup.assistantPriority === "number" && Number.isFinite(setup.assistantPriority)
      ? { assistantPriority: setup.assistantPriority }
      : {}),
    ...(setup.assistantVisibility === "manual-only" ||
    setup.assistantVisibility === "visible" ||
    setup.assistantVisibility === "detected-only"
      ? { assistantVisibility: setup.assistantVisibility }
      : {}),
    ...(setup.onboardingFeatured === true ? { onboardingFeatured: true } : {}),
    ...(groupId ? { groupId } : {}),
    ...(groupLabel ? { groupLabel } : {}),
    ...(groupHint ? { groupHint } : {}),
    ...(methodId ? { methodId } : {}),
    ...(onboardingScopes ? { onboardingScopes } : {}),
    ...(modelAllowlist ? { modelAllowlist } : {}),
    ...(Object.keys(modelSelection).length > 0 ? { modelSelection } : {}),
  };
}

function buildNormalizedModelPicker(
  modelPicker: ProviderWizardModelPicker,
  methodId: string | undefined,
): ProviderWizardModelPicker {
  const label = normalizeOptionalString(modelPicker.label);
  const hint = normalizeOptionalString(modelPicker.hint);
  return {
    ...(label ? { label } : {}),
    ...(hint ? { hint } : {}),
    ...(methodId ? { methodId } : {}),
  };
}

function normalizeProviderWizardSurface<T extends { methodId?: string }>(
  params: ProviderValidationContext,
  surface: T | undefined,
  metadataKind: "setup" | "model-picker",
  project: (surface: T, methodId: string | undefined) => T,
): T | undefined {
  if (!surface) {
    return undefined;
  }
  if (params.auth.length === 0) {
    params.pushDiagnostic({
      level: "warn",
      pluginId: params.pluginId,
      source: params.source,
      message: `provider "${params.providerId}" ${metadataKind} metadata ignored because it has no auth methods`,
    });
    return undefined;
  }
  return project(
    surface,
    resolveWizardMethodId({
      ...params,
      methodId: normalizeOptionalString(surface.methodId),
      metadataKind,
    }),
  );
}

function normalizeProviderAuthMethods(params: ProviderValidationContext): ProviderAuthMethod[] {
  const seenMethodIds = new Set<string>();
  const normalized: ProviderAuthMethod[] = [];

  for (const method of params.auth) {
    const methodId = normalizeOptionalString(method.id);
    if (!methodId) {
      params.pushDiagnostic({
        level: "error",
        pluginId: params.pluginId,
        source: params.source,
        message: `provider "${params.providerId}" auth method missing id`,
      });
      continue;
    }
    if (seenMethodIds.has(methodId)) {
      params.pushDiagnostic({
        level: "error",
        pluginId: params.pluginId,
        source: params.source,
        message: `provider "${params.providerId}" auth method duplicated id "${methodId}"`,
      });
      continue;
    }
    seenMethodIds.add(methodId);
    const wizardSetup = method.wizard;
    const wizard = wizardSetup
      ? normalizeProviderWizardSurface(
          { ...params, auth: [{ ...method, id: methodId }] },
          wizardSetup,
          "setup",
          buildNormalizedWizardSetup,
        )
      : undefined;
    const hint = normalizeOptionalString(method.hint);
    normalized.push({
      ...method,
      id: methodId,
      label: normalizeOptionalString(method.label) ?? methodId,
      ...(hint ? { hint } : {}),
      ...(wizard ? { wizard } : {}),
    });
  }

  return normalized;
}

function normalizeProviderWizard(
  params: ProviderValidationContext & { wizard: ProviderPlugin["wizard"] },
): ProviderPlugin["wizard"] {
  if (!params.wizard) {
    return undefined;
  }

  const setup = normalizeProviderWizardSurface(
    params,
    params.wizard.setup,
    "setup",
    buildNormalizedWizardSetup,
  );
  const modelPicker = normalizeProviderWizardSurface(
    params,
    params.wizard.modelPicker,
    "model-picker",
    buildNormalizedModelPicker,
  );
  if (!setup && !modelPicker) {
    return undefined;
  }
  return {
    ...(setup ? { setup } : {}),
    ...(modelPicker ? { modelPicker } : {}),
  };
}

/** Normalizes provider plugin metadata and emits diagnostics for invalid public fields. */
export function normalizeRegisteredProvider(params: {
  pluginId: string;
  source: string;
  provider: ProviderPlugin;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderPlugin | null {
  const id = normalizeOptionalString(params.provider.id);
  if (!id) {
    params.pushDiagnostic({
      level: "error",
      pluginId: params.pluginId,
      source: params.source,
      message: "provider registration missing id",
    });
    return null;
  }

  const auth = normalizeProviderAuthMethods({
    providerId: id,
    pluginId: params.pluginId,
    source: params.source,
    auth: params.provider.auth ?? [],
    pushDiagnostic: params.pushDiagnostic,
  });
  const docsPath = normalizeOptionalString(params.provider.docsPath);
  const aliases = normalizeTextList(params.provider.aliases);
  const deprecatedProfileIds = normalizeTextList(params.provider.deprecatedProfileIds);
  const oauthProfileIdRepairs = normalizeProviderOAuthProfileIdRepairs(
    params.provider.oauthProfileIdRepairs,
  );
  const envVars = normalizeTextList(params.provider.envVars);
  const wizard = normalizeProviderWizard({
    providerId: id,
    pluginId: params.pluginId,
    source: params.source,
    auth,
    wizard: params.provider.wizard,
    pushDiagnostic: params.pushDiagnostic,
  });
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
    ...(wizard ? { wizard } : {}),
  };
}
