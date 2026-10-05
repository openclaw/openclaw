import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizePluginsConfigWithResolverCore } from "../plugins/config-normalization-shared.js";
import {
  normalizePluginId,
  isExplicitPluginDisableMarker,
  isRetiredPluginId,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "../plugins/config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "../plugins/default-enablement.js";
import { findUninspectedPluginDiagnostic } from "../plugins/discovery-availability.js";
import { resolveManifestCommandAliasOwnerInRegistry } from "../plugins/manifest-command-aliases.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  isNativeSessionCatalogOptOutOnly,
  shippedNativeSessionCatalogs,
} from "../plugins/native-session-catalog-config.js";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginInstallSources,
} from "../plugins/official-external-plugin-catalog.js";
import { createPluginManifestIdNormalizer } from "../plugins/plugin-manifest-id-normalizer.js";
import { normalizePluginPolicyId } from "../plugins/plugin-policy-id.js";
import { hasKind } from "../plugins/slots.js";
import { isRecord, resolveUserPath } from "../utils.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import { shouldSuppressMissingCodexPluginDiagnostics } from "./codex-plugin-diagnostics.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import {
  validatePreparedPluginSchemaValue,
  type PreparedPluginSchemaValidations,
} from "./validation-prepared.js";

const BLOCKED_PLUGIN_CANDIDATE_PREFIX = "blocked plugin candidate:";

export function formatChannelConfigIssueMessage(message: string, pluginId?: string): string {
  const safePluginId = pluginId ? sanitizeForLog(pluginId).trim() : "";
  return safePluginId
    ? `invalid config for plugin ${safePluginId}: ${message}`
    : `invalid config: ${message}`;
}

/** Deferred channel settings remain authored inputs until their owning plugin can validate them. */
export function resolveDeferredChannelConfigWarning(params: {
  channelId: string;
  schemaPluginId: string | undefined;
  deferredPluginIds: ReadonlySet<string>;
  registry: PluginManifestRegistry;
}): ConfigValidationIssue | undefined {
  const pluginId =
    params.schemaPluginId ??
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === params.channelId)
      ?.pluginId ??
    params.registry.plugins.find((record) => record.channels.includes(params.channelId))?.id;
  return pluginId && params.deferredPluginIds.has(normalizePluginId(pluginId))
    ? {
        path: `channels.${params.channelId}`,
        message: `Plugin "${pluginId}" channel settings cannot be checked until its data/settings upgrade finishes. Your existing settings have been kept. Run "openclaw update status" for repair details.`,
      }
    : undefined;
}

function formatRemovedPluginConfigWarning(pluginId: string): string {
  if (pluginId === "skill-workshop") {
    return "plugin removed: skill-workshop (stale plugin config ignored; Skill Workshop is built into OpenClaw skills now. Use skills.workshop settings and openclaw skills workshop commands, then remove this plugins config entry)";
  }
  return `plugin removed: ${pluginId} (stale config entry ignored; remove it from plugins config)`;
}

function formatMissingOfficialExternalPluginWarning(
  pluginId: string,
  opts?: { selectedMissingMemorySlot?: boolean },
): string | null {
  const catalogEntry = getOfficialExternalPluginCatalogEntry(pluginId);
  if (!catalogEntry) {
    return null;
  }
  const installSpec = resolveOfficialExternalPluginInstallSources(catalogEntry)[0]?.spec;
  if (!installSpec) {
    return null;
  }
  if (pluginId === "memory-lancedb" && opts?.selectedMissingMemorySlot) {
    return `plugin not installed: ${pluginId} — gateway will run without persistent memory until installed; install the official external plugin with: openclaw plugins install ${installSpec}`;
  }
  return `plugin not installed: ${pluginId} — install the official external plugin with: openclaw plugins install ${installSpec}`;
}

export function validateExplicitPluginConfig(params: {
  raw: unknown;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  applyDefaults: boolean;
  schemaValidations?: PreparedPluginSchemaValidations;
  registry: PluginManifestRegistry;
  deferredPluginIds?: ReadonlySet<string>;
  ensureCompatPluginIds: () => ReadonlySet<string>;
  ensureOverriddenPluginIds: () => Set<string>;
  replacePluginEntryConfig: (pluginId: string, nextValue: Record<string, unknown>) => void;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
}): void {
  const {
    raw,
    config,
    env,
    applyDefaults,
    registry,
    ensureCompatPluginIds,
    ensureOverriddenPluginIds,
    issues,
    warnings,
  } = params;
  // An unavailable configured path may override any discovered plugin's schema.
  if (findUninspectedPluginDiagnostic(registry.diagnostics)) {
    return;
  }
  const knownIds = new Set(registry.plugins.map((record) => record.id));
  const resolvePluginId = createPluginManifestIdNormalizer(registry);
  const resolveConfigPluginId = (id: string) => resolvePluginId(normalizePluginId(id));
  const resolvePolicyId = (id: string) => normalizePluginPolicyId(resolveConfigPluginId(id));
  const normalizedPlugins = normalizePluginsConfigWithResolverCore(
    config.plugins,
    resolveConfigPluginId,
  );
  const hasKnownPlugin = (id: string) => knownIds.has(resolveConfigPluginId(id));
  const blockedPluginDiagnostics = new Map<string, { message: string; source?: string }>();
  const blockedPluginDiagnosticsWithSource: Array<{ message: string; source: string }> = [];
  const normalizeBlockedDiagnosticPath = (value: string | undefined): string => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return path.resolve(resolveUserPath(trimmed, env ?? process.env));
    } catch {
      return path.resolve(trimmed);
    }
  };
  for (const diag of registry.diagnostics) {
    if (!diag.message.startsWith(BLOCKED_PLUGIN_CANDIDATE_PREFIX)) {
      continue;
    }
    if (!diag.pluginId && diag.source) {
      blockedPluginDiagnosticsWithSource.push({ message: diag.message, source: diag.source });
    }
    if (diag.pluginId) {
      const normalizedPluginId = normalizePluginId(diag.pluginId);
      for (const key of [diag.pluginId, normalizedPluginId]) {
        if (key && !blockedPluginDiagnostics.has(key)) {
          blockedPluginDiagnostics.set(key, {
            message: diag.message,
            ...(diag.source ? { source: diag.source } : {}),
          });
        }
      }
    }
  }
  const blockedDiagnosticSourceMatchesPluginId = (
    diagnostic: { message: string; source: string },
    pluginId: string,
  ): boolean => {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return false;
    }
    const sourcePath = normalizeBlockedDiagnosticPath(diagnostic.source);
    if (!sourcePath) {
      return false;
    }
    if (
      normalizePluginId(path.basename(sourcePath)) === normalizedPluginId ||
      normalizePluginId(path.basename(path.dirname(sourcePath))) === normalizedPluginId
    ) {
      return true;
    }
    const loadPaths = config.plugins?.load?.paths;
    if (!Array.isArray(loadPaths)) {
      return false;
    }
    for (const loadPath of loadPaths) {
      if (typeof loadPath !== "string") {
        continue;
      }
      const resolvedLoadPath = normalizeBlockedDiagnosticPath(loadPath);
      if (
        resolvedLoadPath &&
        normalizePluginId(path.basename(resolvedLoadPath)) === normalizedPluginId &&
        (isPathInside(resolvedLoadPath, sourcePath) || isPathInside(sourcePath, resolvedLoadPath))
      ) {
        return true;
      }
    }
    return false;
  };
  const findBlockedPluginDiagnostic = (pluginId: string) =>
    blockedPluginDiagnostics.get(pluginId) ??
    blockedPluginDiagnostics.get(normalizePluginId(pluginId)) ??
    blockedPluginDiagnosticsWithSource.find((diagnostic) =>
      blockedDiagnosticSourceMatchesPluginId(diagnostic, pluginId),
    );
  const missingOfficialPluginWarningIds = new Set<string>();
  const deferredPluginWarningIds = new Set<string>();
  const noteDeferredPlugin = (pluginId: string, issuePath: string): boolean => {
    const normalized = normalizePluginId(pluginId);
    if (!params.deferredPluginIds?.has(normalized)) {
      return false;
    }
    if (!deferredPluginWarningIds.has(normalized)) {
      deferredPluginWarningIds.add(normalized);
      warnings.push({
        path: issuePath,
        message: `Plugin "${pluginId}" settings cannot be checked until its data/settings upgrade finishes. Your existing settings have been kept. Run "openclaw update status" for repair details.`,
      });
    }
    return true;
  };
  const pushMissingPluginIssue = (
    issuePath: string,
    pluginId: string,
    options?: {
      warnOnly?: boolean;
      officialInstallHint?: boolean;
      missingMessage?: string | null;
    },
  ) => {
    if (noteDeferredPlugin(pluginId, issuePath)) {
      return;
    }
    if (isRetiredPluginId(pluginId)) {
      warnings.push({ path: issuePath, message: formatRemovedPluginConfigWarning(pluginId) });
      return;
    }
    const blockedDiagnostic = findBlockedPluginDiagnostic(pluginId);
    if (blockedDiagnostic) {
      const source = blockedDiagnostic.source ? `; source: ${blockedDiagnostic.source}` : "";
      const message = `plugin present but blocked: ${pluginId} (see preceding plugin warning${source}; fix the blocked plugin path instead of removing config)`;
      (options?.warnOnly ? warnings : issues).push({ path: issuePath, message });
      return;
    }
    if (
      normalizePluginId(pluginId) === "codex" &&
      issuePath === "plugins.entries.codex" &&
      shouldSuppressMissingCodexPluginDiagnostics(
        config,
        env ?? process.env,
        isRecord(raw) ? (raw as OpenClawConfig) : undefined,
      )
    ) {
      return;
    }
    if (options?.warnOnly && options.officialInstallHint !== false) {
      const externalInstallWarning =
        options.missingMessage ?? formatMissingOfficialExternalPluginWarning(pluginId);
      if (externalInstallWarning) {
        const normalizedPluginId = normalizePluginId(pluginId);
        if (!options.missingMessage && normalizedPluginId) {
          if (missingOfficialPluginWarningIds.has(normalizedPluginId)) {
            return;
          }
          missingOfficialPluginWarningIds.add(normalizedPluginId);
        }
        warnings.push({ path: issuePath, message: externalInstallWarning });
        return;
      }
    }
    const message = options?.warnOnly
      ? `plugin not found: ${pluginId} (stale config entry ignored; remove it from plugins config)`
      : `plugin not found: ${pluginId}`;
    (options?.warnOnly ? warnings : issues).push({ path: issuePath, message });
  };

  const pluginsConfig = config.plugins;
  const entries = pluginsConfig?.entries;
  const authoredEntryIds = new Map(
    Object.keys(entries ?? {}).map((id) => [resolvePolicyId(id), id]),
  );
  for (const [id, entry] of Object.entries(entries ?? {})) {
    if (Object.hasOwn(entry, "config")) {
      authoredEntryIds.set(resolvePolicyId(id), id);
    }
  }
  // Normalized entries gain optional keys, so inspect the original disable marker shape.
  const hasIntentionalDisableMarker = (pluginId: string) =>
    isExplicitPluginDisableMarker(entries?.[pluginId]) && !isRetiredPluginId(pluginId);
  if (entries && isRecord(entries)) {
    for (const pluginId of Object.keys(entries)) {
      if (
        !hasKnownPlugin(pluginId) &&
        !hasIntentionalDisableMarker(pluginId) &&
        !isNativeSessionCatalogOptOutOnly(pluginId, entries[pluginId])
      ) {
        // Keep gateway startup resilient when plugins are removed/renamed across upgrades.
        pushMissingPluginIssue(`plugins.entries.${pluginId}`, pluginId, { warnOnly: true });
      }
    }
  }
  for (const pluginId of pluginsConfig?.allow ?? []) {
    if (typeof pluginId !== "string" || !pluginId.trim() || hasKnownPlugin(pluginId)) {
      continue;
    }
    const commandAlias = resolveManifestCommandAliasOwnerInRegistry({
      command: pluginId,
      registry,
    });
    if (commandAlias?.pluginId && knownIds.has(commandAlias.pluginId)) {
      warnings.push({
        path: "plugins.allow",
        message:
          `"${pluginId}" is not a plugin — it is a command provided by the "${commandAlias.pluginId}" plugin. ` +
          `Use "${commandAlias.pluginId}" in plugins.allow instead.`,
      });
    } else if (!hasIntentionalDisableMarker(pluginId)) {
      pushMissingPluginIssue("plugins.allow", pluginId, { warnOnly: true });
    }
  }
  for (const pluginId of pluginsConfig?.deny ?? []) {
    if (typeof pluginId === "string" && pluginId.trim() && !hasKnownPlugin(pluginId)) {
      pushMissingPluginIssue("plugins.deny", pluginId, {
        warnOnly: true,
        officialInstallHint: false,
      });
    }
  }

  // The default memory slot is inferred; only a user-configured slot should block startup.
  const pluginSlots = pluginsConfig?.slots;
  const hasExplicitMemorySlot = pluginSlots !== undefined && Object.hasOwn(pluginSlots, "memory");
  const memorySlot = normalizedPlugins.slots.memory;
  if (
    hasExplicitMemorySlot &&
    typeof memorySlot === "string" &&
    memorySlot.trim() &&
    !hasKnownPlugin(memorySlot)
  ) {
    const missingMessage = formatMissingOfficialExternalPluginWarning(memorySlot, {
      selectedMissingMemorySlot: true,
    });
    const isMissingOfficialExternalMemorySlot =
      memorySlot === "memory-lancedb" && Boolean(missingMessage);
    pushMissingPluginIssue("plugins.slots.memory", memorySlot, {
      warnOnly: isMissingOfficialExternalMemorySlot && !findBlockedPluginDiagnostic(memorySlot),
      missingMessage,
    });
  }

  let selectedMemoryPluginId: string | null = null;
  const seenPlugins = new Set<string>();
  for (const record of registry.plugins) {
    const pluginId = record.id;
    if (seenPlugins.has(pluginId)) {
      continue;
    }
    seenPlugins.add(pluginId);
    if (noteDeferredPlugin(pluginId, `plugins.entries.${pluginId}`)) {
      continue;
    }
    const policyId = resolvePolicyId(pluginId);
    const entryId = authoredEntryIds.get(policyId) ?? policyId;
    const entry = normalizedPlugins.entries[policyId];
    const entryHasConfig = Boolean(entry?.config);
    const activationState = resolveEffectivePluginActivationState({
      id: pluginId,
      origin: record.origin,
      channelIds: record.channels,
      config: normalizedPlugins,
      rootConfig: config,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
    });
    let enabled = activationState.activated;
    let reason = activationState.reason;
    if (enabled) {
      const memoryDecision = resolveMemorySlotDecision({
        id: pluginId,
        kind: record.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        enabled = false;
        reason = memoryDecision.reason;
      }
      if (memoryDecision.selected && hasKind(record.kind, "memory")) {
        selectedMemoryPluginId = pluginId;
      }
    }
    if (enabled || entryHasConfig) {
      if (record.configSchema) {
        const result = validatePreparedPluginSchemaValue(
          {
            origin: record.origin,
            schema: record.configSchema,
            cacheKey: record.schemaCacheKey ?? record.manifestPath ?? pluginId,
            value: entry?.config ?? {},
            applyDefaults: true, // Always apply defaults for AJV schema validation;
            // writeConfigFile persists persistCandidate, not validated.config (#61841)
          },
          params.schemaValidations,
        );
        if (!result.ok) {
          for (const error of result.errors) {
            const base = `plugins.entries.${entryId}.config`;
            issues.push({
              path: !error.path || error.path === "<root>" ? base : `${base}.${error.path}`,
              message: `invalid config: ${error.message}`,
              allowedValues: error.allowedValues,
              allowedValuesHiddenCount: error.allowedValuesHiddenCount,
            });
          }
        } else if (entryHasConfig || (applyDefaults && enabled)) {
          let nextValue = result.value as Record<string, unknown>;
          const nativeCatalog =
            record.setup?.nativeSessionCatalog ??
            shippedNativeSessionCatalogs.find((catalog) => catalog.pluginId === pluginId);
          const authoredCatalog =
            isRecord(entry?.config) && isRecord(entry.config.sessionCatalog)
              ? entry.config.sessionCatalog
              : undefined;
          if (
            nativeCatalog &&
            isRecord(nextValue.sessionCatalog) &&
            Object.hasOwn(nextValue.sessionCatalog, "enabled") &&
            !Object.hasOwn(authoredCatalog ?? {}, "enabled")
          ) {
            // Plugin-local defaults remain intact. Root runtime config must not
            // mistake a schema default for an authored discovery preference.
            const sessionCatalog = { ...nextValue.sessionCatalog };
            delete sessionCatalog.enabled;
            nextValue = { ...nextValue, sessionCatalog };
          }
          params.replacePluginEntryConfig(entryId, nextValue);
        }
      } else if (record.format !== "bundle") {
        issues.push({
          path: `plugins.entries.${entryId}`,
          message: `plugin schema missing for ${pluginId}`,
        });
      }
    }
    const suppressDisabledConfigWarning =
      isNativeSessionCatalogOptOutOnly(pluginId, entries?.[entryId]) ||
      (ensureCompatPluginIds().has(pluginId) && !ensureOverriddenPluginIds().has(pluginId));
    if (!enabled && entryHasConfig && !suppressDisabledConfigWarning) {
      warnings.push({
        path: `plugins.entries.${entryId}`,
        message: `plugin disabled (${reason ?? "disabled"}) but config is present`,
      });
    }
  }
}
