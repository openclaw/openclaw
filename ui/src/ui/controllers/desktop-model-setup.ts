import type { ConfigSnapshot, ModelAuthStatusResult, ModelCatalogEntry } from "../types.ts";

export const DESKTOP_MODEL_SETUP_PRESETS = [
  {
    id: "anthropic",
    providerId: "anthropic",
    defaultModelId: "claude-sonnet-4-6",
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  {
    id: "openai",
    providerId: "openai",
    defaultModelId: "gpt-5.5",
    requiresApiKey: false,
    requiresBaseUrl: false,
  },
  {
    id: "openrouter",
    providerId: "openrouter",
    defaultModelId: "anthropic/claude-sonnet-4-6",
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  {
    id: "custom",
    providerId: "local-openai",
    defaultModelId: "",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    requiresApiKey: false,
    requiresBaseUrl: true,
  },
] as const;

export type DesktopModelSetupPreset = (typeof DESKTOP_MODEL_SETUP_PRESETS)[number]["id"];

export type DesktopModelSetupForm = {
  preset: DesktopModelSetupPreset;
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  displayName: string;
};

export type DesktopModelSetupStatus = {
  required: boolean;
  configuredModelCount: number;
  primaryModel: string | null;
};

function presetById(preset: DesktopModelSetupPreset) {
  return (
    DESKTOP_MODEL_SETUP_PRESETS.find((entry) => entry.id === preset) ??
    DESKTOP_MODEL_SETUP_PRESETS[0]
  );
}

export function createDesktopModelSetupForm(
  preset: DesktopModelSetupPreset = "anthropic",
  previous?: Partial<DesktopModelSetupForm>,
): DesktopModelSetupForm {
  const entry = presetById(preset);
  return {
    preset,
    providerId: entry.providerId,
    modelId: entry.defaultModelId,
    baseUrl: "defaultBaseUrl" in entry ? entry.defaultBaseUrl : "",
    apiKey: previous?.apiKey ?? "",
    displayName: "",
  };
}

export function updateDesktopModelSetupForm(
  current: DesktopModelSetupForm,
  patch: Partial<DesktopModelSetupForm>,
): DesktopModelSetupForm {
  if (patch.preset && patch.preset !== current.preset) {
    return {
      ...createDesktopModelSetupForm(patch.preset, current),
      ...patch,
    };
  }
  return { ...current, ...patch };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function editableConfig(snapshot: ConfigSnapshot | null | undefined): Record<string, unknown> {
  return (
    asRecord(snapshot?.sourceConfig) ??
    asRecord(snapshot?.config) ??
    asRecord(snapshot?.resolved) ??
    {}
  );
}

function primaryFromModelConfig(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return typeof record.primary === "string" && record.primary.trim() ? record.primary.trim() : null;
}

function findMainAgentPrimaryModel(config: Record<string, unknown>): string | null {
  const agents = asRecord(config.agents);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const main = list
    .map((entry) => asRecord(entry))
    .find((entry) => entry?.id === "main" || entry?.default === true);
  return primaryFromModelConfig(main?.model);
}

function findDefaultPrimaryModel(config: Record<string, unknown>): string | null {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  return primaryFromModelConfig(defaults?.model);
}

function primaryProviderFromCatalog(
  primaryModel: string,
  models: readonly ModelCatalogEntry[],
): string | null {
  const [providerFromRef] = primaryModel.includes("/") ? primaryModel.split("/", 1) : [];
  if (providerFromRef?.trim()) {
    return providerFromRef.trim();
  }
  const catalogEntry = models.find(
    (entry) => entry.id === primaryModel || entry.alias === primaryModel,
  );
  return catalogEntry?.provider?.trim() || null;
}

function requiresFreshAuthSetup(params: {
  primaryModel: string | null;
  models: readonly ModelCatalogEntry[];
  authStatus?: ModelAuthStatusResult | null;
}): boolean {
  if (!params.primaryModel) {
    return false;
  }
  const providerId = primaryProviderFromCatalog(params.primaryModel, params.models);
  if (!providerId) {
    return false;
  }
  const providerStatus = params.authStatus?.providers?.find(
    (entry) => entry.provider === providerId,
  );
  return providerStatus?.status === "expired" || providerStatus?.status === "missing";
}

export function resolveDesktopModelSetupStatus(params: {
  snapshot?: ConfigSnapshot | null;
  models?: ModelCatalogEntry[] | null;
  authStatus?: ModelAuthStatusResult | null;
}): DesktopModelSetupStatus {
  const config = editableConfig(params.snapshot);
  const primaryModel = findMainAgentPrimaryModel(config) ?? findDefaultPrimaryModel(config);
  const models = params.models ?? [];
  const configuredModelCount = models.length;
  return {
    required:
      !primaryModel ||
      configuredModelCount === 0 ||
      requiresFreshAuthSetup({
        primaryModel,
        models,
        authStatus: params.authStatus,
      }),
    configuredModelCount,
    primaryModel,
  };
}

function normalizeProviderId(value: string): string {
  return value.trim();
}

function normalizeModelId(providerId: string, value: string): string {
  const trimmed = value.trim();
  const prefix = `${providerId}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
}

function buildDesktopAgentListPatch(config: Record<string, unknown>, modelRef: string): unknown[] {
  const agents = asRecord(config.agents);
  const existingList = Array.isArray(agents?.list) ? agents.list : [];
  const mainPatch = { id: "main", model: { primary: modelRef } };
  if (existingList.length === 0) {
    return [mainPatch];
  }

  let updatedMain = false;
  const next = existingList.map((entry) => {
    const record = asRecord(entry);
    if (!record || record.id !== "main") {
      return entry;
    }
    updatedMain = true;
    const model = asRecord(record.model) ?? {};
    return {
      ...record,
      model: {
        ...model,
        primary: modelRef,
      },
    };
  });
  return updatedMain ? next : [...next, mainPatch];
}

function isEmptyRecord(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && Object.keys(record).length === 0;
}

function buildDefaultModelAllowlistPatch(
  config: Record<string, unknown>,
  modelRef: string,
): Record<string, unknown> {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const existingModels = asRecord(defaults?.models);
  const patch: Record<string, unknown> = {};

  if (existingModels && Object.values(existingModels).every(isEmptyRecord)) {
    for (const existingRef of Object.keys(existingModels)) {
      if (existingRef !== modelRef) {
        patch[existingRef] = null;
      }
    }
  }

  patch[modelRef] = {};
  return patch;
}

export function validateDesktopModelSetupForm(form: DesktopModelSetupForm): string[] {
  const preset = presetById(form.preset);
  const providerId = normalizeProviderId(form.providerId);
  const modelId = normalizeModelId(providerId, form.modelId);
  const issues: string[] = [];
  if (!providerId) {
    issues.push("Provider ID is required.");
  } else if (providerId.includes("/")) {
    issues.push("Provider ID must not contain '/'.");
  }
  if (!modelId) {
    issues.push("Model ID is required.");
  }
  if (preset.requiresBaseUrl && !form.baseUrl.trim()) {
    issues.push("Base URL is required for custom providers.");
  }
  if (preset.requiresApiKey && !form.apiKey.trim()) {
    issues.push("API key is required for this provider.");
  }
  return issues;
}

export function buildDesktopModelSetupPatch(
  form: DesktopModelSetupForm,
  options?: { snapshot?: ConfigSnapshot | null },
): {
  modelRef: string;
  patch: Record<string, unknown>;
} {
  const issues = validateDesktopModelSetupForm(form);
  if (issues.length > 0) {
    throw new Error(issues.join(" "));
  }

  const providerId = normalizeProviderId(form.providerId);
  const modelId = normalizeModelId(providerId, form.modelId);
  const modelRef = `${providerId}/${modelId}`;
  const config = editableConfig(options?.snapshot);
  const defaultModels = buildDefaultModelAllowlistPatch(config, modelRef);
  const providerConfig: Record<string, unknown> = {
    models: [{ id: modelId, name: form.displayName.trim() || modelId }],
  };
  if (form.apiKey.trim()) {
    providerConfig.apiKey = form.apiKey.trim();
  }
  if (form.preset === "custom") {
    providerConfig.baseUrl = form.baseUrl.trim();
    providerConfig.api = "openai-completions";
  } else if (form.baseUrl.trim()) {
    providerConfig.baseUrl = form.baseUrl.trim();
  }

  return {
    modelRef,
    patch: {
      agents: {
        defaults: {
          model: { primary: modelRef },
          models: defaultModels,
        },
        list: buildDesktopAgentListPatch(config, modelRef),
      },
      models: {
        providers: {
          [providerId]: providerConfig,
        },
      },
    },
  };
}
