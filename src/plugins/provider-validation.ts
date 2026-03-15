import type { PluginDiagnostic, ProviderAuthMethod, ProviderPlugin } from "./types.js";

function pushProviderDiagnostic(params: {
  level: PluginDiagnostic["level"];
  pluginId: string;
  source: string;
  message: string;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}) {
  params.pushDiagnostic({
    level: params.level,
    pluginId: params.pluginId,
    source: params.source,
    message: params.message,
  });
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTextList(values: string[] | undefined): string[] | undefined {
  const normalized = Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderAuthMethods(params: {
  providerId: string;
  pluginId: string;
  source: string;
  auth: ProviderAuthMethod[];
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderAuthMethod[] {
  const seenMethodIds = new Set<string>();
  const normalized: ProviderAuthMethod[] = [];

  for (const method of params.auth) {
    const methodId = normalizeText(method.id);
    if (!methodId) {
      pushProviderDiagnostic({
        level: "error",
        pluginId: params.pluginId,
        source: params.source,
        message: `provider "${params.providerId}" auth method missing id`,
        pushDiagnostic: params.pushDiagnostic,
      });
      continue;
    }
    if (seenMethodIds.has(methodId)) {
      pushProviderDiagnostic({
        level: "error",
        pluginId: params.pluginId,
        source: params.source,
        message: `provider "${params.providerId}" auth method duplicated id "${methodId}"`,
        pushDiagnostic: params.pushDiagnostic,
      });
      continue;
    }
    seenMethodIds.add(methodId);
    normalized.push({
      ...method,
      id: methodId,
      label: normalizeText(method.label) ?? methodId,
      ...(normalizeText(method.hint) ? { hint: normalizeText(method.hint) } : {}),
    });
  }

  return normalized;
}

function normalizeProviderWizard(params: {
  providerId: string;
  pluginId: string;
  source: string;
  auth: ProviderAuthMethod[];
  wizard: ProviderPlugin["wizard"];
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderPlugin["wizard"] {
  if (!params.wizard) {
    return undefined;
  }

  const hasAuthMethods = params.auth.length > 0;
  const hasMethod = (methodId: string | undefined) =>
    Boolean(methodId && params.auth.some((method) => method.id === methodId));

  const normalizeOnboarding = () => {
    const onboarding = params.wizard?.onboarding;
    if (!onboarding) {
      return undefined;
    }
    if (!hasAuthMethods) {
      pushProviderDiagnostic({
        level: "warn",
        pluginId: params.pluginId,
        source: params.source,
        message: `provider "${params.providerId}" onboarding metadata ignored because it has no auth methods`,
        pushDiagnostic: params.pushDiagnostic,
      });
      return undefined;
    }
    const methodId = normalizeText(onboarding.methodId);
    if (methodId && !hasMethod(methodId)) {
      pushProviderDiagnostic({
        level: "warn",
        pluginId: params.pluginId,
        source: params.source,
        message: `provider "${params.providerId}" onboarding method "${methodId}" not found; falling back to available methods`,
        pushDiagnostic: params.pushDiagnostic,
      });
    }
    return {
      ...(normalizeText(onboarding.choiceId)
        ? { choiceId: normalizeText(onboarding.choiceId) }
        : {}),
      ...(normalizeText(onboarding.choiceLabel)
        ? { choiceLabel: normalizeText(onboarding.choiceLabel) }
        : {}),
      ...(normalizeText(onboarding.choiceHint)
        ? { choiceHint: normalizeText(onboarding.choiceHint) }
        : {}),
      ...(normalizeText(onboarding.groupId) ? { groupId: normalizeText(onboarding.groupId) } : {}),
      ...(normalizeText(onboarding.groupLabel)
        ? { groupLabel: normalizeText(onboarding.groupLabel) }
        : {}),
      ...(normalizeText(onboarding.groupHint)
        ? { groupHint: normalizeText(onboarding.groupHint) }
        : {}),
      ...(methodId && hasMethod(methodId) ? { methodId } : {}),
    };
  };

  const normalizeModelPicker = () => {
    const modelPicker = params.wizard?.modelPicker;
    if (!modelPicker) {
      return undefined;
    }
    if (!hasAuthMethods) {
      pushProviderDiagnostic({
        level: "warn",
        pluginId: params.pluginId,
        source: params.source,
        message: `provider "${params.providerId}" model-picker metadata ignored because it has no auth methods`,
        pushDiagnostic: params.pushDiagnostic,
      });
      return undefined;
    }
    const methodId = normalizeText(modelPicker.methodId);
    if (methodId && !hasMethod(methodId)) {
      pushProviderDiagnostic({
        level: "warn",
        pluginId: params.pluginId,
        source: params.source,
        message: `provider "${params.providerId}" model-picker method "${methodId}" not found; falling back to available methods`,
        pushDiagnostic: params.pushDiagnostic,
      });
    }
    return {
      ...(normalizeText(modelPicker.label) ? { label: normalizeText(modelPicker.label) } : {}),
      ...(normalizeText(modelPicker.hint) ? { hint: normalizeText(modelPicker.hint) } : {}),
      ...(methodId && hasMethod(methodId) ? { methodId } : {}),
    };
  };

  const onboarding = normalizeOnboarding();
  const modelPicker = normalizeModelPicker();
  if (!onboarding && !modelPicker) {
    return undefined;
  }
  return {
    ...(onboarding ? { onboarding } : {}),
    ...(modelPicker ? { modelPicker } : {}),
  };
}

export function normalizeRegisteredProvider(params: {
  pluginId: string;
  source: string;
  provider: ProviderPlugin;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ProviderPlugin | null {
  const id = normalizeText(params.provider.id);
  if (!id) {
    pushProviderDiagnostic({
      level: "error",
      pluginId: params.pluginId,
      source: params.source,
      message: "provider registration missing id",
      pushDiagnostic: params.pushDiagnostic,
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
  const docsPath = normalizeText(params.provider.docsPath);
  const aliases = normalizeTextList(params.provider.aliases);
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
  const discovery = params.provider.discovery;
  if (catalog && discovery) {
    pushProviderDiagnostic({
      level: "warn",
      pluginId: params.pluginId,
      source: params.source,
      message: `provider "${id}" registered both catalog and discovery; using catalog`,
      pushDiagnostic: params.pushDiagnostic,
    });
  }
  const {
    wizard: _ignoredWizard,
    docsPath: _ignoredDocsPath,
    aliases: _ignoredAliases,
    envVars: _ignoredEnvVars,
    catalog: _ignoredCatalog,
    discovery: _ignoredDiscovery,
    ...restProvider
  } = params.provider;
  return {
    ...restProvider,
    id,
    label: normalizeText(params.provider.label) ?? id,
    ...(docsPath ? { docsPath } : {}),
    ...(aliases ? { aliases } : {}),
    ...(envVars ? { envVars } : {}),
    auth,
    ...(catalog ? { catalog } : {}),
    ...(!catalog && discovery ? { discovery } : {}),
    ...(wizard ? { wizard } : {}),
  };
}
