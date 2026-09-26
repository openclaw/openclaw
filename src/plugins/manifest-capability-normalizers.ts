import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import {
  normalizeOptionalTrimmedStringList,
  normalizeTrimmedStringList,
} from "../../packages/normalization-core/src/string-normalization.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { isRecord } from "../utils.js";
import { PLUGIN_MANIFEST_CONTRACT_KEYS } from "./manifest-contract-keys.js";
import type {
  DecisionProviderCapabilities,
  PluginManifest,
  PluginManifestCapabilityProviderAuthSignal,
  PluginManifestCapabilityProviderConfigSignal,
  PluginManifestCapabilityProviderMetadata,
  PluginManifestCapabilityProviderModeConfigSignal,
  PluginManifestCatalog,
  PluginManifestConfigContracts,
  PluginManifestConfigLiteral,
  PluginManifestContracts,
  PluginManifestDangerousConfigFlag,
  PluginManifestDecisionModel,
  PluginManifestMcpServer,
  PluginManifestMediaUnderstandingCapability,
  PluginManifestMediaUnderstandingProviderMetadata,
  PluginManifestProviderBaseUrlGuard,
  PluginManifestSecretInputContracts,
  PluginManifestSecretInputPath,
  PluginManifestToolMetadata,
  PluginManifestToolProfile,
  PluginManifestTranscriptSource,
} from "./manifest-types.js";

// Accept only bounded declarative facts; unknown or malformed fields never enter tool guidance.
function normalizeDecisionCapabilities(value: unknown): DecisionProviderCapabilities | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.questionTypes) ||
    value.questionTypes.length === 0 ||
    value.questionTypes.length > 3 ||
    !value.questionTypes.every(
      (kind) => kind === "boolean" || kind === "choice" || kind === "score",
    )
  ) {
    return undefined;
  }
  const capabilities: DecisionProviderCapabilities = {
    questionTypes: [...new Set<"boolean" | "choice" | "score">(value.questionTypes)],
  };
  // Limits are provider facts, not host admission overrides.
  for (const key of [
    "maxQuestions",
    "maxChoiceAlternatives",
    "maxScoreLevels",
    "maxInputTokens",
  ] as const) {
    const limit = value[key];
    if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
      capabilities[key] = limit;
    }
  }
  if (
    value.inputTokenScope === "encoded-question" ||
    value.inputTokenScope === "state-plus-each-criterion"
  ) {
    capabilities.inputTokenScope = value.inputTokenScope;
  }
  if (typeof value.requiresBooleanCriteria === "boolean") {
    capabilities.requiresBooleanCriteria = value.requiresBooleanCriteria;
  }
  if (value.confidence === "provider-specific" || value.confidence === "none") {
    capabilities.confidence = value.confidence;
  }
  return capabilities;
}

/** Normalize provider-owned model descriptors without importing provider code. */
export function normalizeManifestDecisionModels(
  value: unknown,
  providers: readonly string[] | undefined,
): PluginManifestDecisionModel[] | undefined {
  const seen = new Set<string>();
  return normalizeManifestObjectList(value, (entry) => {
    const provider = normalizeOptionalString(entry.provider);
    const id = normalizeOptionalString(entry.id);
    const name = normalizeOptionalString(entry.name);
    if (!provider || !id || !name || !providers?.includes(provider)) {
      return undefined;
    }
    const ref = `${provider}/${id}`;
    if (seen.has(ref)) {
      return undefined;
    }
    const capabilities = normalizeDecisionCapabilities(entry.capabilities);
    seen.add(ref);
    return { provider, id, name, ...(capabilities ? { capabilities } : {}) };
  });
}

/** Endpoint restrictions constrain a provider alias without changing stored credential identity. */
export function normalizeManifestProviderAuthAliases(
  value: unknown,
): PluginManifest["providerAuthAliases"] {
  return normalizeManifestRecord(value, (entry) => {
    if (typeof entry === "string") {
      return normalizeOptionalString(entry);
    }
    if (isRecord(entry)) {
      const provider = normalizeOptionalString(entry.provider);
      const baseUrls = normalizeTrimmedStringList(entry.baseUrls);
      if (provider && baseUrls.length > 0) {
        return { provider, baseUrls };
      }
    }
    return undefined;
  });
}

function isPluginToolProfile(profile: string): profile is PluginManifestToolProfile {
  return (
    profile === "minimal" || profile === "coding" || profile === "messaging" || profile === "full"
  );
}

export function normalizeStringListRecord(value: unknown): Record<string, string[]> | undefined {
  return normalizeManifestRecord(value, normalizeOptionalTrimmedStringList);
}

export function normalizeManifestStringRecord(value: unknown): Record<string, string> | undefined {
  return normalizeManifestRecord(value, normalizeOptionalString);
}

export function normalizeManifestMcpServers(
  value: unknown,
): Record<string, PluginManifestMcpServer> | undefined {
  return normalizeNamedMetadataRecord(value, (server) => ({ ...server }));
}

function normalizeManifestRecord<T>(
  value: unknown,
  normalizeEntry: (entry: unknown, id: string) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, T> = Object.create(null);
  for (const [rawId, rawEntry] of Object.entries(value)) {
    const id = normalizeOptionalString(rawId) ?? "";
    const entry = !id || isBlockedObjectKey(id) ? undefined : normalizeEntry(rawEntry, id);
    if (entry) {
      normalized[id] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeNamedMetadataRecord<T>(
  value: unknown,
  normalizeEntry: (entry: Record<string, unknown>, id: string) => T | undefined,
): Record<string, T> | undefined {
  return normalizeManifestRecord(value, (entry, id) =>
    isRecord(entry) ? normalizeEntry(entry, id) : undefined,
  );
}

export function normalizeManifestObjectList<T>(
  value: unknown,
  normalizeEntry: (entry: Record<string, unknown>) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: T[] = [];
  for (const entry of value) {
    const result = isRecord(entry) ? normalizeEntry(entry) : undefined;
    if (result !== undefined) {
      normalized.push(result);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeManifestTranscriptSources(
  value: unknown,
  ownedProviders: readonly string[] = [],
): Record<string, PluginManifestTranscriptSource> | undefined {
  const locatorKeys = ["accountId", "guildId", "channelId", "meetingUrl"] as const;
  return normalizeNamedMetadataRecord(value, (entry, id) => {
    if (!ownedProviders.includes(id)) {
      return undefined;
    }
    const name = normalizeOptionalString(entry.name);
    const raw = entry.autoStart;
    const autoStart: PluginManifestTranscriptSource["autoStart"] =
      isRecord(raw) &&
      Object.entries(raw).every(
        ([key, mode]) =>
          locatorKeys.some((locator) => locator === key) &&
          (mode === "optional" || mode === "required"),
      )
        ? Object.fromEntries(Object.entries(raw))
        : undefined;
    return name || autoStart
      ? { ...(name ? { name } : {}), ...(autoStart ? { autoStart } : {}) }
      : undefined;
  });
}

const MEDIA_UNDERSTANDING_CAPABILITIES = new Set(["image", "audio", "video"]);

function normalizeMediaUnderstandingCapabilityRecord(
  value: unknown,
): Partial<Record<PluginManifestMediaUnderstandingCapability, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Partial<Record<PluginManifestMediaUnderstandingCapability, string>> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!MEDIA_UNDERSTANDING_CAPABILITIES.has(rawKey)) {
      continue;
    }
    const model = normalizeOptionalString(rawValue);
    if (model) {
      normalized[rawKey as PluginManifestMediaUnderstandingCapability] = model;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeMediaUnderstandingPriorityRecord(
  value: unknown,
): Partial<Record<PluginManifestMediaUnderstandingCapability, number>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Partial<Record<PluginManifestMediaUnderstandingCapability, number>> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (
      !MEDIA_UNDERSTANDING_CAPABILITIES.has(rawKey) ||
      typeof rawValue !== "number" ||
      !Number.isFinite(rawValue)
    ) {
      continue;
    }
    normalized[rawKey as PluginManifestMediaUnderstandingCapability] = rawValue;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeMediaUnderstandingCapabilities(
  value: unknown,
): PluginManifestMediaUnderstandingCapability[] | undefined {
  const values = normalizeTrimmedStringList(value).filter((entry) =>
    MEDIA_UNDERSTANDING_CAPABILITIES.has(entry),
  ) as PluginManifestMediaUnderstandingCapability[];
  return values.length > 0 ? values : undefined;
}

function normalizeMediaUnderstandingNativeDocumentInputs(value: unknown): Array<"pdf"> | undefined {
  const values = normalizeTrimmedStringList(value).filter((entry) => entry === "pdf");
  return values.length > 0 ? values : undefined;
}

function normalizeMediaUnderstandingDocumentModels(
  value: unknown,
): PluginManifestMediaUnderstandingProviderMetadata["documentModels"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pdfRaw = value.pdf;
  if (!isRecord(pdfRaw)) {
    return undefined;
  }
  const textExtraction = normalizeOptionalString(pdfRaw.textExtraction);
  const image: string | false | undefined =
    pdfRaw.image === false ? false : normalizeOptionalString(pdfRaw.image);
  const pdf = {
    ...(textExtraction ? { textExtraction } : {}),
    ...(image !== undefined ? { image } : {}),
  };
  return Object.keys(pdf).length > 0 ? { pdf } : undefined;
}

export function normalizeMediaUnderstandingProviderMetadata(
  value: unknown,
): Record<string, PluginManifestMediaUnderstandingProviderMetadata> | undefined {
  return normalizeNamedMetadataRecord(value, (rawMetadata) => {
    const capabilities = normalizeMediaUnderstandingCapabilities(rawMetadata.capabilities);
    const defaultModels = normalizeMediaUnderstandingCapabilityRecord(rawMetadata.defaultModels);
    const autoPriority = normalizeMediaUnderstandingPriorityRecord(rawMetadata.autoPriority);
    const nativeDocumentInputs = normalizeMediaUnderstandingNativeDocumentInputs(
      rawMetadata.nativeDocumentInputs,
    );
    const documentModels = normalizeMediaUnderstandingDocumentModels(rawMetadata.documentModels);
    const metadata = {
      ...(capabilities ? { capabilities } : {}),
      ...(defaultModels ? { defaultModels } : {}),
      ...(autoPriority ? { autoPriority } : {}),
      ...(nativeDocumentInputs ? { nativeDocumentInputs } : {}),
      ...(documentModels ? { documentModels } : {}),
    } satisfies PluginManifestMediaUnderstandingProviderMetadata;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  });
}

function normalizeProviderBaseUrlGuard(
  value: unknown,
): PluginManifestProviderBaseUrlGuard | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = normalizeOptionalString(value.provider);
  const allowedBaseUrls = normalizeTrimmedStringList(value.allowedBaseUrls);
  if (!provider || allowedBaseUrls.length === 0) {
    return undefined;
  }
  const defaultBaseUrl = normalizeOptionalString(value.defaultBaseUrl);
  return {
    provider,
    ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
    allowedBaseUrls,
  };
}

function normalizeCapabilityProviderAuthSignals(
  value: unknown,
): PluginManifestCapabilityProviderAuthSignal[] | undefined {
  return normalizeManifestObjectList(value, (rawSignal) => {
    const provider = normalizeOptionalString(rawSignal.provider);
    if (!provider) {
      return undefined;
    }
    const providerBaseUrl = normalizeProviderBaseUrlGuard(rawSignal.providerBaseUrl);
    return {
      provider,
      ...(providerBaseUrl ? { providerBaseUrl } : {}),
    };
  });
}

function normalizeCapabilityProviderModeConfigSignal(
  value: unknown,
): PluginManifestCapabilityProviderModeConfigSignal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pathResult = normalizeOptionalString(value.path);
  const defaultValue = normalizeOptionalString(value.default);
  const allowed = normalizeTrimmedStringList(value.allowed);
  const disallowed = normalizeTrimmedStringList(value.disallowed);
  const signal = {
    ...(pathResult ? { path: pathResult } : {}),
    ...(defaultValue ? { default: defaultValue } : {}),
    ...(allowed.length > 0 ? { allowed } : {}),
    ...(disallowed.length > 0 ? { disallowed } : {}),
  } satisfies PluginManifestCapabilityProviderModeConfigSignal;
  return Object.keys(signal).length > 0 ? signal : undefined;
}

function normalizeCapabilityProviderConfigSignals(
  value: unknown,
): PluginManifestCapabilityProviderConfigSignal[] | undefined {
  return normalizeManifestObjectList(value, (rawSignal) => {
    const rootPath = normalizeOptionalString(rawSignal.rootPath);
    if (!rootPath) {
      return undefined;
    }
    const overlayPath = normalizeOptionalString(rawSignal.overlayPath);
    const overlayMapPath = normalizeOptionalString(rawSignal.overlayMapPath);
    const required = normalizeTrimmedStringList(rawSignal.required);
    const requiredAny = normalizeTrimmedStringList(rawSignal.requiredAny);
    const mode = normalizeCapabilityProviderModeConfigSignal(rawSignal.mode);
    const signal = {
      rootPath,
      ...(overlayPath ? { overlayPath } : {}),
      ...(overlayMapPath ? { overlayMapPath } : {}),
      ...(required.length > 0 ? { required } : {}),
      ...(requiredAny.length > 0 ? { requiredAny } : {}),
      ...(mode ? { mode } : {}),
    } satisfies PluginManifestCapabilityProviderConfigSignal;
    return required.length > 0 || requiredAny.length > 0 || mode ? signal : undefined;
  });
}

function normalizeCapabilityProviderMetadataEntry(
  rawMetadata: Record<string, unknown>,
): PluginManifestCapabilityProviderMetadata | undefined {
  const aliases = normalizeTrimmedStringList(rawMetadata.aliases);
  const authProviders = normalizeTrimmedStringList(rawMetadata.authProviders);
  const authSignals = normalizeCapabilityProviderAuthSignals(rawMetadata.authSignals);
  const configSignals = normalizeCapabilityProviderConfigSignals(rawMetadata.configSignals);
  const referenceAudioInputs = rawMetadata.referenceAudioInputs === true ? true : undefined;
  const metadata = {
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(authProviders.length > 0 ? { authProviders } : {}),
    ...(authSignals ? { authSignals } : {}),
    ...(configSignals ? { configSignals } : {}),
    ...(referenceAudioInputs ? { referenceAudioInputs } : {}),
  } satisfies PluginManifestCapabilityProviderMetadata;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function normalizeCapabilityProviderMetadata(
  value: unknown,
): Record<string, PluginManifestCapabilityProviderMetadata> | undefined {
  return normalizeNamedMetadataRecord(value, normalizeCapabilityProviderMetadataEntry);
}

export function normalizePluginToolMetadata(
  value: unknown,
): Record<string, PluginManifestToolMetadata> | undefined {
  return normalizeNamedMetadataRecord(value, (rawMetadata) => {
    const providerMetadata = normalizeCapabilityProviderMetadataEntry(rawMetadata);
    const profiles = normalizeTrimmedStringList(rawMetadata.profiles).filter(isPluginToolProfile);
    const metadata = {
      ...providerMetadata,
      ...(rawMetadata.optional === true ? { optional: true } : {}),
      ...(profiles.length > 0 ? { profiles } : {}),
      ...(rawMetadata.replaySafe === true ? { replaySafe: true } : {}),
      ...(rawMetadata.sideEffecting === true ? { sideEffecting: true } : {}),
    } satisfies PluginManifestToolMetadata;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  });
}

export function normalizeManifestCatalog(value: unknown): PluginManifestCatalog | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const featured = typeof value.featured === "boolean" ? value.featured : undefined;
  const order =
    typeof value.order === "number" && Number.isFinite(value.order) ? value.order : undefined;
  if (featured === undefined && order === undefined) {
    return undefined;
  }
  return {
    ...(featured !== undefined ? { featured } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

export function normalizeManifestContracts(value: unknown): PluginManifestContracts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const contracts: PluginManifestContracts = {};
  for (const key of PLUGIN_MANIFEST_CONTRACT_KEYS) {
    const entries = normalizeTrimmedStringList(value[key]);
    if (entries.length > 0) {
      contracts[key] = entries;
    }
  }
  return Object.keys(contracts).length > 0 ? contracts : undefined;
}

function isManifestConfigLiteral(value: unknown): value is PluginManifestConfigLiteral {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function normalizeManifestDangerousConfigFlags(
  value: unknown,
): PluginManifestDangerousConfigFlag[] | undefined {
  return normalizeManifestObjectList(value, (entry) => {
    const pathValue = normalizeOptionalString(entry.path) ?? "";
    return pathValue && isManifestConfigLiteral(entry.equals)
      ? { path: pathValue, equals: entry.equals }
      : undefined;
  });
}

function normalizeManifestSecretInputPaths(
  value: unknown,
): PluginManifestSecretInputPath[] | undefined {
  return normalizeManifestObjectList(value, (entry) => {
    const pathLocal = normalizeOptionalString(entry.path) ?? "";
    if (!pathLocal) {
      return undefined;
    }
    const expected = entry.expected === "string" ? entry.expected : undefined;
    const ownerKind =
      entry.ownerKind === "capability" || entry.ownerKind === "route" ? entry.ownerKind : undefined;
    return {
      path: pathLocal,
      ...(expected ? { expected } : {}),
      ...(ownerKind ? { ownerKind } : {}),
    };
  });
}

export function normalizeManifestConfigContracts(
  value: unknown,
): PluginManifestConfigContracts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const compatibilityMigrationPaths = normalizeTrimmedStringList(value.compatibilityMigrationPaths);
  const compatibilityRuntimePaths = normalizeTrimmedStringList(value.compatibilityRuntimePaths);
  const rawSecretInputs = isRecord(value.secretInputs) ? value.secretInputs : undefined;
  const dangerousFlags = normalizeManifestDangerousConfigFlags(value.dangerousFlags);
  const secretInputPaths = rawSecretInputs
    ? normalizeManifestSecretInputPaths(rawSecretInputs.paths)
    : undefined;
  const secretInputs = secretInputPaths
    ? ({
        ...(typeof rawSecretInputs?.bundledDefaultEnabled === "boolean"
          ? { bundledDefaultEnabled: rawSecretInputs.bundledDefaultEnabled }
          : {}),
        paths: secretInputPaths,
      } satisfies PluginManifestSecretInputContracts)
    : undefined;
  const configContracts = {
    ...(compatibilityMigrationPaths.length > 0 ? { compatibilityMigrationPaths } : {}),
    ...(compatibilityRuntimePaths.length > 0 ? { compatibilityRuntimePaths } : {}),
    ...(dangerousFlags ? { dangerousFlags } : {}),
    ...(secretInputs ? { secretInputs } : {}),
  } satisfies PluginManifestConfigContracts;
  return Object.keys(configContracts).length > 0 ? configContracts : undefined;
}
