import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import {
  normalizeOptionalTrimmedStringList,
  normalizeTrimmedStringList,
  normalizeUniqueTrimmedStringList,
} from "../../packages/normalization-core/src/string-normalization.js";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.config.js";
import {
  normalizeCommandDescriptorName,
  sanitizeCommandDescriptorDescription,
} from "../cli/program/command-descriptor-utils.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { ChannelAccountKeyPolicy } from "../routing/account-lookup.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { isRecord } from "../utils.js";
import {
  normalizeManifestObjectList,
  normalizeNamedMetadataRecord,
  omitUndefinedManifestFields,
} from "./manifest-capability-normalizers.js";
import { normalizeManifestPlatforms } from "./manifest-platforms.js";
import type {
  PluginManifestActivation,
  PluginManifestActivationCapability,
  PluginManifestChannelCommandDefaults,
  PluginManifestChannelConfig,
  PluginManifestCliCommand,
  PluginManifestControlUi,
  PluginManifestDashboard,
  PluginManifestDashboardActionVerb,
  PluginManifestDashboardDataBinding,
  PluginManifestOnboardingScope,
  PluginManifestProviderAuthChoice,
  PluginManifestQaRunner,
  PluginManifestSetup,
  PluginManifestSetupProvider,
  PluginManifestSetupProviderAuthEvidence,
  PluginConfigUiHint,
} from "./manifest-types.js";
import { normalizeSetupPresentationHttpsUrl } from "./setup-presentation-url.js";

export function normalizeManifestActivation(value: unknown): PluginManifestActivation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const activation: PluginManifestActivation = {};
  if (typeof value.onStartup === "boolean") {
    activation.onStartup = value.onStartup;
  }
  for (const key of [
    "onProviders",
    "onAgentHarnesses",
    "onCommands",
    "onChannels",
    "onRoutes",
    "onConfigPaths",
  ] as const) {
    const entries = normalizeTrimmedStringList(value[key]);
    if (entries.length > 0) {
      activation[key] = entries;
    }
  }
  const onCapabilities = normalizeTrimmedStringList(value.onCapabilities).filter(
    (capability): capability is PluginManifestActivationCapability =>
      capability === "provider" ||
      capability === "channel" ||
      capability === "tool" ||
      capability === "hook",
  );

  if (onCapabilities.length > 0) {
    activation.onCapabilities = onCapabilities;
  }

  return Object.keys(activation).length > 0 ? activation : undefined;
}

export function normalizeChannelAccountKeyPolicies(
  value: unknown,
  channels: readonly string[],
): Record<string, ChannelAccountKeyPolicy> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const policies: Record<string, ChannelAccountKeyPolicy> = Object.create(null);
  for (const channel of channels) {
    if (isBlockedObjectKey(channel) || !Object.hasOwn(value, channel)) {
      continue;
    }
    const entry = value[channel];
    const field = isRecord(entry)
      ? normalizeOptionalString(entry.canonicalAliasesRequireOwnField)
      : undefined;
    if (field && !isBlockedObjectKey(field)) {
      policies[channel] = { canonicalAliasesRequireOwnField: field };
    }
  }
  return Object.keys(policies).length ? policies : undefined;
}

export function normalizeManifestCliCommands(
  value: unknown,
): PluginManifestCliCommand[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  return (
    normalizeManifestObjectList(value, (entry) => {
      if (typeof entry.name !== "string" || typeof entry.description !== "string") {
        return undefined;
      }
      const name = normalizeCommandDescriptorName(entry.name);
      const description = sanitizeCommandDescriptorDescription(entry.description);
      if (!name || !description || typeof entry.hasSubcommands !== "boolean" || seen.has(name)) {
        return undefined;
      }
      seen.add(name);
      return { name, description, hasSubcommands: entry.hasSubcommands };
    }) ?? []
  );
}

function normalizeManifestSetupProviders(
  value: unknown,
): PluginManifestSetupProvider[] | undefined {
  return normalizeManifestObjectList(value, (entry) => {
    const id = normalizeOptionalString(entry.id) ?? "";
    if (!id) {
      return undefined;
    }
    return omitUndefinedManifestFields({
      id,
      authMethods: normalizeOptionalTrimmedStringList(entry.authMethods),
      envVars: normalizeOptionalTrimmedStringList(entry.envVars),
      authEvidence: normalizeManifestSetupProviderAuthEvidence(entry.authEvidence),
    });
  });
}

function normalizeManifestSetupProviderAuthEvidence(
  value: unknown,
): PluginManifestSetupProviderAuthEvidence[] | undefined {
  return normalizeManifestObjectList(value, (entry) => {
    if (entry.type !== "local-file-with-env") {
      return undefined;
    }
    const credentialMarker = normalizeOptionalString(entry.credentialMarker);
    if (!credentialMarker) {
      return undefined;
    }
    const fileEnvVar = normalizeOptionalString(entry.fileEnvVar);
    const fallbackPaths = normalizeOptionalTrimmedStringList(entry.fallbackPaths);
    if (!fileEnvVar && !fallbackPaths) {
      return undefined;
    }
    return omitUndefinedManifestFields<PluginManifestSetupProviderAuthEvidence>({
      type: "local-file-with-env",
      fileEnvVar,
      fallbackPaths,
      requiresAnyEnv: normalizeOptionalTrimmedStringList(entry.requiresAnyEnv),
      requiresAllEnv: normalizeOptionalTrimmedStringList(entry.requiresAllEnv),
      credentialMarker,
      source: normalizeOptionalString(entry.source),
    });
  });
}

export function normalizeManifestSetup(value: unknown): PluginManifestSetup | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providers = normalizeManifestSetupProviders(value.providers);
  const cliBackends = normalizeTrimmedStringList(value.cliBackends);
  const configMigrations = normalizeTrimmedStringList(value.configMigrations);
  const nativeSessionCatalog = isRecord(value.nativeSessionCatalog)
    ? {
        label: normalizeOptionalString(value.nativeSessionCatalog.label) ?? "",
        description: normalizeOptionalString(value.nativeSessionCatalog.description),
        nodeCommands: normalizeTrimmedStringList(value.nativeSessionCatalog.nodeCommands),
        legacyDefaultEnabled: value.nativeSessionCatalog.legacyDefaultEnabled === true,
      }
    : undefined;
  const requiresRuntime =
    typeof value.requiresRuntime === "boolean" ? value.requiresRuntime : undefined;
  const setup = {
    ...(providers ? { providers } : {}),
    ...(cliBackends.length > 0 ? { cliBackends } : {}),
    ...(configMigrations.length > 0 ? { configMigrations } : {}),
    ...(nativeSessionCatalog?.label
      ? {
          nativeSessionCatalog: {
            label: nativeSessionCatalog.label,
            ...(nativeSessionCatalog.legacyDefaultEnabled ? { legacyDefaultEnabled: true } : {}),
            ...(nativeSessionCatalog.nodeCommands.length > 0
              ? { nodeCommands: nativeSessionCatalog.nodeCommands }
              : {}),
            ...(nativeSessionCatalog.description
              ? { description: nativeSessionCatalog.description }
              : {}),
          },
        }
      : {}),
    ...(requiresRuntime !== undefined ? { requiresRuntime } : {}),
  } satisfies PluginManifestSetup;
  return Object.keys(setup).length > 0 ? setup : undefined;
}

export function normalizeManifestQaRunners(value: unknown): PluginManifestQaRunner[] | undefined {
  return normalizeManifestObjectList(value, (entry) => {
    const commandName = normalizeOptionalString(entry.commandName) ?? "";
    if (!commandName) {
      return undefined;
    }
    return omitUndefinedManifestFields({
      commandName,
      description: normalizeOptionalString(entry.description),
    });
  });
}

type DashboardManifestResult =
  | { ok: true; dashboard?: PluginManifestDashboard }
  | { ok: false; error: string };

function normalizeDashboardCapabilityBase(
  value: unknown,
  field: string,
  index: number,
): { id: string; method: string; description: string } | string {
  if (!isRecord(value)) {
    return `${field}[${index}] must be an object`;
  }
  const id = normalizeOptionalString(value.id);
  const method = normalizeOptionalString(value.method);
  const description = normalizeOptionalString(value.description);
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    return `${field}[${index}].id must be a lowercase capability id`;
  }
  if (!method) {
    return `${field}[${index}].method must be a non-empty string`;
  }
  if (!description) {
    return `${field}[${index}].description must be a non-empty string`;
  }
  return { id, method, description };
}

export function normalizeManifestDashboard(value: unknown): DashboardManifestResult {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "dashboard must be an object" };
  }
  if (value.dataBindings !== undefined && !Array.isArray(value.dataBindings)) {
    return { ok: false, error: "dashboard.dataBindings must be an array" };
  }
  if (value.actionVerbs !== undefined && !Array.isArray(value.actionVerbs)) {
    return { ok: false, error: "dashboard.actionVerbs must be an array" };
  }

  const dataBindings: PluginManifestDashboardDataBinding[] = [];
  for (const [index, entry] of (value.dataBindings ?? []).entries()) {
    const normalized = normalizeDashboardCapabilityBase(entry, "dashboard.dataBindings", index);
    if (typeof normalized === "string") {
      return { ok: false, error: normalized };
    }
    dataBindings.push(normalized);
  }

  const actionVerbs: PluginManifestDashboardActionVerb[] = [];
  for (const [index, entry] of (value.actionVerbs ?? []).entries()) {
    const normalized = normalizeDashboardCapabilityBase(entry, "dashboard.actionVerbs", index);
    if (typeof normalized === "string") {
      return { ok: false, error: normalized };
    }
    const rawParamShape = isRecord(entry) ? entry.paramShape : undefined;
    if (rawParamShape !== undefined && !isRecord(rawParamShape)) {
      return {
        ok: false,
        error: `dashboard.actionVerbs[${index}].paramShape must be a JSON Schema object`,
      };
    }
    actionVerbs.push({
      ...normalized,
      ...(rawParamShape ? { paramShape: rawParamShape as JsonSchemaObject } : {}),
    });
  }

  if (dataBindings.length === 0 && actionVerbs.length === 0) {
    return { ok: true };
  }
  return {
    ok: true,
    dashboard: {
      ...(dataBindings.length > 0 ? { dataBindings } : {}),
      ...(actionVerbs.length > 0 ? { actionVerbs } : {}),
    },
  };
}

export function normalizeManifestControlUi(
  value: unknown,
): Result<PluginManifestControlUi | undefined, string> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "entry" && key !== "styles")) {
    return err("controlUi must contain only entry and optional styles");
  }
  const entry = typeof value.entry === "string" ? value.entry.replace(/^\.\//u, "") : "";
  // A dedicated built directory prevents a declaration from publishing package sources.
  const builtEntry = /^dist\/(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.m?js$/u;
  if (entry.length > 512 || !builtEntry.test(entry)) {
    return err("controlUi.entry must be a JavaScript file in a dedicated dist subdirectory");
  }
  if (value.styles !== undefined && (!Array.isArray(value.styles) || value.styles.length > 16)) {
    return err("controlUi.styles must be an array of at most 16 stylesheets");
  }
  const assetPrefix = entry.slice(0, entry.lastIndexOf("/") + 1);
  const styles: string[] = [];
  for (const rawStyle of value.styles ?? []) {
    const style = typeof rawStyle === "string" ? rawStyle.replace(/^\.\//u, "") : "";
    if (
      style.length > 512 ||
      !style.startsWith(assetPrefix) ||
      !/^(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.css$/u.test(style)
    ) {
      return err("controlUi.styles must contain CSS files under the entry's asset directory");
    }
    if (!styles.includes(style)) {
      styles.push(style);
    }
  }
  return ok({ entry, ...(styles.length > 0 ? { styles } : {}) });
}

function normalizeProviderChannelLogin(
  value: unknown,
): PluginManifestProviderAuthChoice["channelLogin"] | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "aliases")) {
    return undefined;
  }
  if (
    value.aliases !== undefined &&
    (!Array.isArray(value.aliases) ||
      value.aliases.some((alias) => typeof alias !== "string" || !alias.trim()))
  ) {
    return undefined;
  }
  const aliases = normalizeUniqueTrimmedStringList(value.aliases);
  return aliases.length > 0 ? { aliases } : {};
}

export function normalizeProviderAuthChoices(
  value: unknown,
): PluginManifestProviderAuthChoice[] | undefined {
  return normalizeManifestObjectList(value, (entry) => {
    const provider = normalizeOptionalString(entry.provider) ?? "";
    const method = normalizeOptionalString(entry.method) ?? "";
    const choiceId = normalizeOptionalString(entry.choiceId) ?? "";
    if (!provider || !method || !choiceId) {
      return undefined;
    }
    const onboardingScopes = normalizeTrimmedStringList(entry.onboardingScopes).filter(
      (scope): scope is PluginManifestOnboardingScope =>
        scope === "text-inference" || scope === "image-generation" || scope === "music-generation",
    );
    return omitUndefinedManifestFields<PluginManifestProviderAuthChoice>({
      provider,
      method,
      choiceId,
      modelTarget: entry.modelTarget === "utility" ? "utility" : undefined,
      platforms:
        entry.platforms !== undefined ? normalizeManifestPlatforms(entry.platforms) : undefined,
      choiceLabel: normalizeOptionalString(entry.choiceLabel),
      choiceHint: normalizeOptionalString(entry.choiceHint),
      icon: normalizeSetupPresentationHttpsUrl(entry.icon),
      website: normalizeSetupPresentationHttpsUrl(entry.website),
      docsUrl: normalizeSetupPresentationHttpsUrl(entry.docsUrl),
      assistantPriority:
        typeof entry.assistantPriority === "number" && Number.isFinite(entry.assistantPriority)
          ? entry.assistantPriority
          : undefined,
      assistantVisibility:
        entry.assistantVisibility === "manual-only" ||
        entry.assistantVisibility === "visible" ||
        entry.assistantVisibility === "detected-only"
          ? entry.assistantVisibility
          : undefined,
      deprecatedChoiceIds: normalizeOptionalTrimmedStringList(entry.deprecatedChoiceIds),
      groupId: normalizeOptionalString(entry.groupId),
      groupLabel: normalizeOptionalString(entry.groupLabel),
      groupHint: normalizeOptionalString(entry.groupHint),
      onboardingFeatured: entry.onboardingFeatured === true ? true : undefined,
      appGuidedDiscovery: entry.appGuidedDiscovery === true ? true : undefined,
      optionKey: normalizeOptionalString(entry.optionKey),
      cliFlag: normalizeOptionalString(entry.cliFlag),
      cliOption: normalizeOptionalString(entry.cliOption),
      cliDescription: normalizeOptionalString(entry.cliDescription),
      appGuidedSecret: entry.appGuidedSecret === true ? true : undefined,
      personalAccount: entry.personalAccount === true ? true : undefined,
      appGuidedActionLabel: normalizeOptionalString(entry.appGuidedActionLabel),
      appGuidedAuth:
        entry.appGuidedAuth === "oauth" || entry.appGuidedAuth === "device-code"
          ? entry.appGuidedAuth
          : undefined,
      credentialOnly: entry.credentialOnly === true ? true : undefined,
      channelLogin: normalizeProviderChannelLogin(entry.channelLogin),
      onboardingScopes: onboardingScopes.length > 0 ? onboardingScopes : undefined,
    });
  });
}

export function normalizeConfigUiHints(
  value: unknown,
): Record<string, PluginConfigUiHint> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginConfigUiHint> = Object.create(null);
  for (const [hintPath, rawHint] of Object.entries(value)) {
    if (!isRecord(rawHint)) {
      continue;
    }
    const hint = { ...rawHint } as Record<string, unknown>;
    if ("presentation" in hint && hint.presentation !== "phone-number") {
      delete hint.presentation;
    }
    normalized[hintPath] = hint as PluginConfigUiHint;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeChannelConfigs(
  value: unknown,
): Record<string, PluginManifestChannelConfig> | undefined {
  return normalizeNamedMetadataRecord(value, (rawEntry) => {
    const schema = isRecord(rawEntry.schema) ? rawEntry.schema : null;
    if (!schema) {
      return undefined;
    }
    const uiHints = normalizeConfigUiHints(rawEntry.uiHints);
    const runtime =
      isRecord(rawEntry.runtime) && typeof rawEntry.runtime.safeParse === "function"
        ? (rawEntry.runtime as ChannelConfigRuntimeSchema)
        : undefined;
    const label = normalizeOptionalString(rawEntry.label) ?? "";
    const description = normalizeOptionalString(rawEntry.description) ?? "";
    const preferOver = normalizeTrimmedStringList(rawEntry.preferOver);
    const commandDefaults = normalizeManifestChannelCommandDefaults(rawEntry.commands);
    return {
      schema,
      ...(uiHints ? { uiHints } : {}),
      ...(runtime ? { runtime } : {}),
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(preferOver.length > 0 ? { preferOver } : {}),
      ...(commandDefaults ? { commands: commandDefaults } : {}),
    };
  });
}

export function normalizeManifestChannelCommandDefaults(
  value: unknown,
): PluginManifestChannelCommandDefaults | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const commands: PluginManifestChannelCommandDefaults = {};
  for (const key of ["nativeCommandsAutoEnabled", "nativeSkillsAutoEnabled"] as const) {
    if (typeof value[key] === "boolean") {
      commands[key] = value[key];
    }
  }
  return Object.keys(commands).length > 0 ? commands : undefined;
}
