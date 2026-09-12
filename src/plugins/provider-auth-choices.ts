// Builds provider auth choice lists from plugin setup metadata.
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestProviderAuthChoice } from "./manifest-types.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalProviderCatalogEntries,
} from "./official-external-plugin-catalog.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type ProviderAuthChoiceMetadata = Omit<
  PluginManifestProviderAuthChoice,
  "provider" | "method" | "choiceLabel"
> & {
  pluginId: string;
  providerId: string;
  methodId: string;
  choiceLabel: string;
};

type ProviderOnboardAuthFlag = {
  optionKey: string;
  authChoice: string;
  cliFlag: string;
  cliOption: string;
  description: string;
};

type ProviderAuthChoiceCandidate = ProviderAuthChoiceMetadata & {
  origin: PluginOrigin;
};
type ManifestProviderAuthChoiceParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  includeUntrustedWorkspacePlugins?: boolean;
  includeWorkspacePlugins?: boolean;
};

const PROVIDER_AUTH_CHOICE_ORIGIN_PRIORITY: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  bundled: 1,
  global: 2,
  workspace: 3,
};
const DESCRIPTOR_LABEL_ACRONYMS: ReadonlyMap<string, string> = new Map([
  ["api", "API"],
  ["jwt", "JWT"],
  ["oauth", "OAuth"],
  ["oidc", "OIDC"],
  ["pkce", "PKCE"],
  ["saml", "SAML"],
  ["sso", "SSO"],
] as const);

function resolveProviderAuthChoiceOriginPriority(origin: PluginOrigin | undefined): number {
  if (!origin) {
    return Number.MAX_SAFE_INTEGER;
  }
  return PROVIDER_AUTH_CHOICE_ORIGIN_PRIORITY[origin] ?? Number.MAX_SAFE_INTEGER;
}

function toProviderAuthChoiceCandidate(params: {
  pluginId: string;
  origin: PluginOrigin;
  choice: NonNullable<PluginManifestRecord["providerAuthChoices"]>[number];
}): ProviderAuthChoiceCandidate {
  const { pluginId, origin, choice } = params;
  const { provider, method, choiceId, choiceLabel, ...metadata } = choice;
  return {
    pluginId,
    origin,
    providerId: provider,
    methodId: method,
    choiceId,
    choiceLabel: choiceLabel ?? choiceId,
    ...metadata,
  };
}

function formatDescriptorLabel(value: string): string {
  return sanitizeForLog(value)
    .trim()
    .split(/[-_\s]+/gu)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      const acronym = DESCRIPTOR_LABEL_ACRONYMS.get(lower);
      if (acronym) {
        return acronym;
      }
      return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function normalizeManifestAuthDescriptorId(value: string): string {
  return sanitizeForLog(value).trim();
}

function toSetupProviderAuthChoiceCandidate(params: {
  plugin: PluginManifestRecord;
  providerId: string;
  methodId: string;
}): ProviderAuthChoiceCandidate {
  const providerLabel = formatDescriptorLabel(params.providerId);
  const methodLabel = formatDescriptorLabel(params.methodId);
  const choiceLabel =
    params.methodId === "api-key" ? `${providerLabel} API key` : `${providerLabel} ${methodLabel}`;
  return {
    pluginId: params.plugin.id,
    origin: params.plugin.origin,
    providerId: params.providerId,
    methodId: params.methodId,
    choiceId: `${params.providerId}-${params.methodId}`,
    choiceLabel,
    groupId: params.providerId,
    groupLabel: providerLabel,
  };
}

function listSetupProviderAuthChoiceCandidates(plugin: PluginManifestRecord) {
  if (plugin.setup?.requiresRuntime !== false && plugin.setupSource) {
    return [];
  }
  const explicitProviderMethods = new Set(
    (plugin.providerAuthChoices ?? []).map((choice) => `${choice.provider}::${choice.method}`),
  );
  return (plugin.setup?.providers ?? []).flatMap((provider) => {
    const providerId = normalizeManifestAuthDescriptorId(provider.id);
    if (!providerId) {
      return [];
    }
    return (provider.authMethods ?? [])
      .map(normalizeManifestAuthDescriptorId)
      .filter(Boolean)
      .filter((methodId) => !explicitProviderMethods.has(`${providerId}::${methodId}`))
      .map((methodId) =>
        toSetupProviderAuthChoiceCandidate({
          plugin,
          providerId,
          methodId,
        }),
      );
  });
}

function stripChoiceOrigin(choice: ProviderAuthChoiceCandidate): ProviderAuthChoiceMetadata {
  const { origin: _origin, ...metadata } = choice;
  return metadata;
}

function resolveManifestProviderAuthChoiceCandidates(
  params?: ManifestProviderAuthChoiceParams,
  declaredOnly = false,
): ProviderAuthChoiceCandidate[] {
  const metadataSnapshot =
    params?.metadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params?.config ?? {},
      workspaceDir: params?.workspaceDir,
      env: params?.env ?? process.env,
    });
  const registry = metadataSnapshot.manifestRegistry;
  const normalizedConfig = normalizePluginsConfig(params?.config?.plugins);
  return registry.plugins.flatMap((plugin) => {
    if (declaredOnly && !passesManifestOwnerBasePolicy({ plugin, normalizedConfig })) {
      return [];
    }
    if (plugin.origin === "workspace" && params?.includeWorkspacePlugins === false) {
      return [];
    }
    if (
      plugin.origin === "workspace" &&
      params?.includeUntrustedWorkspacePlugins === false &&
      !resolveEffectiveEnableState({
        id: plugin.id,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: params?.config,
      }).enabled
    ) {
      return [];
    }
    const choices: ProviderAuthChoiceCandidate[] = [];
    for (const choice of plugin.providerAuthChoices ?? []) {
      choices.push(
        toProviderAuthChoiceCandidate({
          pluginId: plugin.id,
          origin: plugin.origin,
          choice,
        }),
      );
    }
    if (!declaredOnly) {
      choices.push(...listSetupProviderAuthChoiceCandidates(plugin));
    }
    return choices;
  });
}

function pickPreferredManifestAuthChoice(
  candidates: readonly ProviderAuthChoiceCandidate[],
): ProviderAuthChoiceCandidate | undefined {
  let preferred: ProviderAuthChoiceCandidate | undefined;
  let ambiguous = false;
  for (const candidate of candidates) {
    if (!preferred) {
      preferred = candidate;
      continue;
    }
    if (
      resolveProviderAuthChoiceOriginPriority(candidate.origin) <
      resolveProviderAuthChoiceOriginPriority(preferred.origin)
    ) {
      preferred = candidate;
      ambiguous = false;
    } else if (
      resolveProviderAuthChoiceOriginPriority(candidate.origin) ===
      resolveProviderAuthChoiceOriginPriority(preferred.origin)
    ) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : preferred;
}

function resolvePreferredManifestAuthChoicesByChoiceId(
  candidates: readonly ProviderAuthChoiceCandidate[],
): ProviderAuthChoiceCandidate[] {
  const byChoiceId = new Map<string, ProviderAuthChoiceCandidate[]>();
  for (const candidate of candidates) {
    const normalizedChoiceId = candidate.choiceId.trim();
    if (!normalizedChoiceId) {
      continue;
    }
    const group = byChoiceId.get(normalizedChoiceId) ?? [];
    group.push(candidate);
    byChoiceId.set(normalizedChoiceId, group);
  }
  return [...byChoiceId.values()].flatMap((group) => {
    const preferred = pickPreferredManifestAuthChoice(group);
    return preferred ? [preferred] : [];
  });
}

function resolvePreferredManifestAuthChoiceMetadata(params: {
  config?: ManifestProviderAuthChoiceParams;
  matches: (choice: ProviderAuthChoiceCandidate) => boolean;
}): ProviderAuthChoiceMetadata | undefined {
  const candidates = resolveManifestProviderAuthChoiceCandidates(params.config).filter(
    params.matches,
  );
  const preferred = pickPreferredManifestAuthChoice(candidates);
  return preferred ? stripChoiceOrigin(preferred) : undefined;
}

export function resolveManifestProviderAuthChoices(
  params?: ManifestProviderAuthChoiceParams,
): ProviderAuthChoiceMetadata[] {
  return resolvePreferredManifestAuthChoicesByChoiceId(
    resolveManifestProviderAuthChoiceCandidates(params),
  ).map(stripChoiceOrigin);
}

/** Executable declarations exclude workspace code and honor current plugin policy. */
export function resolveManifestDeclaredProviderAuthChoices(
  params?: ManifestProviderAuthChoiceParams,
): ProviderAuthChoiceMetadata[] {
  const candidates = resolveManifestProviderAuthChoiceCandidates(
    { ...params, includeWorkspacePlugins: false },
    true,
  );
  return resolvePreferredManifestAuthChoicesByChoiceId(candidates).map(stripChoiceOrigin);
}

export function resolveManifestProviderAuthChoice(
  choiceId: string,
  params?: ManifestProviderAuthChoiceParams,
): ProviderAuthChoiceMetadata | undefined {
  const normalized = choiceId.trim();
  if (!normalized) {
    return undefined;
  }
  return resolvePreferredManifestAuthChoiceMetadata({
    config: params,
    matches: (choice) => choice.choiceId === normalized,
  });
}

export function resolveManifestDeprecatedProviderAuthChoice(
  choiceId: string,
  params?: ManifestProviderAuthChoiceParams,
): ProviderAuthChoiceMetadata | undefined {
  const normalized = choiceId.trim();
  if (!normalized) {
    return undefined;
  }
  return resolvePreferredManifestAuthChoiceMetadata({
    config: params,
    matches: (choice) => choice.deprecatedChoiceIds?.includes(normalized) === true,
  });
}

function resolveManifestProviderOnboardAuthFlags(
  params?: ManifestProviderAuthChoiceParams,
): ProviderOnboardAuthFlag[] {
  const preferredByFlag = new Map<string, ProviderAuthChoiceCandidate>();

  for (const choice of resolveManifestProviderAuthChoiceCandidates(params)) {
    if (!choice.optionKey || !choice.cliFlag || !choice.cliOption) {
      continue;
    }
    const dedupeKey = `${choice.optionKey}::${choice.cliFlag}`;
    const existing = preferredByFlag.get(dedupeKey);
    if (
      existing &&
      resolveProviderAuthChoiceOriginPriority(choice.origin) >=
        resolveProviderAuthChoiceOriginPriority(existing.origin)
    ) {
      continue;
    }
    preferredByFlag.set(dedupeKey, choice);
  }

  const flags: ProviderOnboardAuthFlag[] = [];
  for (const choice of preferredByFlag.values()) {
    flags.push({
      optionKey: choice.optionKey!,
      authChoice: choice.choiceId,
      cliFlag: choice.cliFlag!,
      cliOption: choice.cliOption!,
      description: choice.cliDescription ?? choice.choiceLabel,
    });
  }
  return flags;
}

function resolveOfficialExternalProviderOnboardAuthFlags(): ProviderOnboardAuthFlag[] {
  const flags: ProviderOnboardAuthFlag[] = [];
  for (const entry of listOfficialExternalProviderCatalogEntries()) {
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    for (const provider of manifest?.providers ?? []) {
      for (const choice of provider.authChoices ?? []) {
        const optionKey = choice.optionKey?.trim();
        const authChoice = choice.choiceId?.trim();
        const cliFlag = choice.cliFlag?.trim();
        const cliOption = choice.cliOption?.trim();
        if (!optionKey || !authChoice || !cliFlag || !cliOption) {
          continue;
        }
        flags.push({
          optionKey,
          authChoice,
          cliFlag,
          cliOption,
          description: choice.cliDescription?.trim() || choice.choiceLabel?.trim() || authChoice,
        });
      }
    }
  }
  return flags;
}

/** Resolves onboard auth flags from installed manifests and official cold-install metadata. */
export function resolveProviderOnboardAuthFlags(
  params?: ManifestProviderAuthChoiceParams,
): ProviderOnboardAuthFlag[] {
  const flags = resolveManifestProviderOnboardAuthFlags(params);
  const seen = new Set(flags.map((flag) => `${flag.optionKey}::${flag.cliFlag}`));
  for (const flag of resolveOfficialExternalProviderOnboardAuthFlags()) {
    const dedupeKey = `${flag.optionKey}::${flag.cliFlag}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    flags.push(flag);
  }
  return flags;
}
