import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { CHANNEL_IDS, normalizeChatChannelId } from "../channels/registry.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
} from "../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import {
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isWindowsAbsolutePath,
} from "../shared/avatar-policy.js";
import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "../shared/net/ip.js";
import { isRecord } from "../utils.js";
import { findDuplicateAgentDirs, formatDuplicateAgentDirError } from "./agent-dirs.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "./allowed-values.js";
import { applyAgentDefaults, applyModelDefaults, applySessionDefaults } from "./defaults.js";
import { findLegacyConfigIssues } from "./legacy.js";
import type { OpenClawConfig, ConfigValidationIssue } from "./types.js";
import { OpenClawSchema } from "./zod-schema.js";

const LEGACY_REMOVED_PLUGIN_IDS = new Set(["google-antigravity-auth"]);

type UnknownIssueRecord = Record<string, unknown>;
type AllowedValuesCollection = {
  values: unknown[];
  incomplete: boolean;
  hasValues: boolean;
};

function toIssueRecord(value: unknown): UnknownIssueRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownIssueRecord;
}

function collectAllowedValuesFromIssue(issue: unknown): AllowedValuesCollection {
  const record = toIssueRecord(issue);
  if (!record) {
    return { values: [], incomplete: false, hasValues: false };
  }
  const code = typeof record.code === "string" ? record.code : "";

  if (code === "invalid_value") {
    const values = record.values;
    if (!Array.isArray(values)) {
      return { values: [], incomplete: true, hasValues: false };
    }
    return { values, incomplete: false, hasValues: values.length > 0 };
  }

  if (code === "invalid_type") {
    const expected = typeof record.expected === "string" ? record.expected : "";
    if (expected === "boolean") {
      return { values: [true, false], incomplete: false, hasValues: true };
    }
    return { values: [], incomplete: true, hasValues: false };
  }

  if (code !== "invalid_union") {
    return { values: [], incomplete: false, hasValues: false };
  }

  const nested = record.errors;
  if (!Array.isArray(nested) || nested.length === 0) {
    return { values: [], incomplete: true, hasValues: false };
  }

  const collected: unknown[] = [];
  for (const branch of nested) {
    if (!Array.isArray(branch) || branch.length === 0) {
      return { values: [], incomplete: true, hasValues: false };
    }
    const branchCollected = collectAllowedValuesFromIssueList(branch);
    if (branchCollected.incomplete || !branchCollected.hasValues) {
      return { values: [], incomplete: true, hasValues: false };
    }
    collected.push(...branchCollected.values);
  }

  return { values: collected, incomplete: false, hasValues: collected.length > 0 };
}

function collectAllowedValuesFromIssueList(
  issues: ReadonlyArray<unknown>,
): AllowedValuesCollection {
  const collected: unknown[] = [];
  let hasValues = false;
  for (const issue of issues) {
    const branch = collectAllowedValuesFromIssue(issue);
    if (branch.incomplete) {
      return { values: [], incomplete: true, hasValues: false };
    }
    if (!branch.hasValues) {
      continue;
    }
    hasValues = true;
    collected.push(...branch.values);
  }
  return { values: collected, incomplete: false, hasValues };
}

function collectAllowedValuesFromUnknownIssue(issue: unknown): unknown[] {
  const collection = collectAllowedValuesFromIssue(issue);
  if (collection.incomplete || !collection.hasValues) {
    return [];
  }
  return collection.values;
}

function mapZodIssueToConfigIssue(issue: unknown): ConfigValidationIssue {
  const record = toIssueRecord(issue);
  const path = Array.isArray(record?.path)
    ? record.path
        .filter((segment): segment is string | number => {
          const segmentType = typeof segment;
          return segmentType === "string" || segmentType === "number";
        })
        .join(".")
    : "";
  const message = typeof record?.message === "string" ? record.message : "Invalid input";
  const allowedValuesSummary = summarizeAllowedValues(collectAllowedValuesFromUnknownIssue(issue));

  if (!allowedValuesSummary) {
    return { path, message };
  }

  return {
    path,
    message: appendAllowedValuesHint(message, allowedValuesSummary),
    allowedValues: allowedValuesSummary.values,
    allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
  };
}

function isWorkspaceAvatarPath(value: string, workspaceDir: string): boolean {
  const workspaceRoot = path.resolve(workspaceDir);
  const resolved = path.resolve(workspaceRoot, value);
  return isPathWithinRoot(workspaceRoot, resolved);
}

function validateIdentityAvatar(config: OpenClawConfig): ConfigValidationIssue[] {
  const agents = config.agents?.list;
  if (!Array.isArray(agents) || agents.length === 0) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  for (const [index, entry] of agents.entries()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const avatarRaw = entry.identity?.avatar;
    if (typeof avatarRaw !== "string") {
      continue;
    }
    const avatar = avatarRaw.trim();
    if (!avatar) {
      continue;
    }
    if (isAvatarDataUrl(avatar) || isAvatarHttpUrl(avatar)) {
      continue;
    }
    if (avatar.startsWith("~")) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
      });
      continue;
    }
    const hasScheme = hasAvatarUriScheme(avatar);
    if (hasScheme && !isWindowsAbsolutePath(avatar)) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
      });
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(
      config,
      entry.id ?? resolveDefaultAgentId(config),
    );
    if (!isWorkspaceAvatarPath(avatar, workspaceDir)) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must stay within the agent workspace.",
      });
    }
  }
  return issues;
}

function validateGatewayTailscaleBind(config: OpenClawConfig): ConfigValidationIssue[] {
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode !== "serve" && tailscaleMode !== "funnel") {
    return [];
  }
  const bindMode = config.gateway?.bind ?? "loopback";
  if (bindMode === "loopback") {
    return [];
  }
  const customBindHost = config.gateway?.customBindHost;
  if (
    bindMode === "custom" &&
    isCanonicalDottedDecimalIPv4(customBindHost) &&
    isLoopbackIpAddress(customBindHost)
  ) {
    return [];
  }
  return [
    {
      path: "gateway.bind",
      message:
        `gateway.bind must resolve to loopback when gateway.tailscale.mode=${tailscaleMode} ` +
        '(use gateway.bind="loopback" or gateway.bind="custom" with gateway.customBindHost="127.0.0.1")',
    },
  ];
}

type RelayRoutingRuleRecord = {
  mode?: string;
  relayTo?: string;
  match?: {
    channel?: string;
    accountId?: string;
    chatId?: string;
  };
};

type RelayRoutingTargetRecord = {
  channel?: string;
  to?: string;
  accountId?: string;
};

function normalizeRelayChannelId(raw: string | undefined): string {
  const normalizedCore = normalizeChatChannelId(raw);
  if (normalizedCore) {
    return normalizedCore;
  }
  return raw?.trim().toLowerCase() ?? "";
}

function normalizeRelayAccountId(raw: string | undefined): string {
  return raw?.trim().toLowerCase() || "default";
}

function relayRuleProtectsTarget(params: {
  rule: RelayRoutingRuleRecord;
  target: { channel: string; to: string; accountId: string };
}): boolean {
  const match = params.rule.match;
  if (!match) {
    return true;
  }
  const matchChannel = normalizeRelayChannelId(match.channel);
  if (matchChannel && matchChannel !== params.target.channel) {
    return false;
  }
  const matchAccountId = normalizeRelayAccountId(match.accountId);
  if (match.accountId && matchAccountId !== params.target.accountId) {
    return false;
  }
  const matchChatId = match.chatId?.trim() ?? "";
  if (matchChatId && matchChatId !== params.target.to) {
    return false;
  }
  return true;
}

function validateRelayRoutingProtectionLoops(config: OpenClawConfig): ConfigValidationIssue[] {
  const relayRouting = config.session?.relayRouting;
  if (!relayRouting) {
    return [];
  }
  const targets = relayRouting.targets ?? {};
  const rules = relayRouting.rules ?? [];
  if (!Array.isArray(rules) || rules.length === 0) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  for (const [index, candidateRule] of rules.entries()) {
    const rule = candidateRule as RelayRoutingRuleRecord;
    if (rule.mode !== "read-only") {
      continue;
    }
    const relayTo = rule.relayTo?.trim();
    if (!relayTo) {
      continue;
    }
    const target = targets[relayTo] as RelayRoutingTargetRecord | undefined;
    if (!target) {
      continue;
    }
    const normalizedTarget = {
      channel: normalizeRelayChannelId(target.channel),
      to: target.to?.trim() ?? "",
      accountId: normalizeRelayAccountId(target.accountId),
    };
    if (!normalizedTarget.channel || !normalizedTarget.to) {
      continue;
    }

    const sourceChannel = normalizeRelayChannelId(rule.match?.channel);
    const sourceChatId = rule.match?.chatId?.trim() ?? "";
    const sourceAccountId = normalizeRelayAccountId(rule.match?.accountId);
    if (
      sourceChannel &&
      sourceChatId &&
      sourceChannel === normalizedTarget.channel &&
      sourceChatId === normalizedTarget.to &&
      sourceAccountId === normalizedTarget.accountId
    ) {
      issues.push({
        path: `session.relayRouting.rules.${index}.relayTo`,
        message:
          `relay target "${relayTo}" cannot be the same as protected source ` +
          `${sourceChannel}:${sourceChatId} (account: ${sourceAccountId})`,
      });
      continue;
    }

    const blockingRuleIndex = rules.findIndex((candidate, candidateIndex) => {
      const blockingRule = candidate as RelayRoutingRuleRecord;
      if (blockingRule.mode !== "read-only") {
        return false;
      }
      if (candidateIndex === index && sourceChannel && sourceChatId) {
        return false;
      }
      return relayRuleProtectsTarget({ rule: blockingRule, target: normalizedTarget });
    });

    if (blockingRuleIndex >= 0) {
      issues.push({
        path: `session.relayRouting.rules.${index}.relayTo`,
        message:
          `relay target "${relayTo}" (${normalizedTarget.channel}:${normalizedTarget.to}) is itself ` +
          "a protected read-only channel, which would create a redirect loop",
      });
    }
  }
  return issues;
}

function validateRelayTargetDestinationFormat(params: {
  channel: string;
  destination: string;
}): string | null {
  if (params.channel === "whatsapp" || params.channel === "signal") {
    if (!/^\+\d{3,20}$/.test(params.destination)) {
      return `relay target destination "${params.destination}" must be E.164 (for example +15551234567) for ${params.channel}`;
    }
    return null;
  }
  if (params.channel === "telegram") {
    const isNumericChatId = /^-?\d+(?::topic:\d+)?$/.test(params.destination);
    const isUsername = /^@[a-zA-Z0-9_]{5,}$/.test(params.destination);
    if (!isNumericChatId && !isUsername) {
      return `relay target destination "${params.destination}" must be a numeric chat id or @username for telegram`;
    }
  }
  return null;
}

/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
export function validateConfigObjectRaw(
  raw: unknown,
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const legacyIssues = findLegacyConfigIssues(raw);
  if (legacyIssues.length > 0) {
    return {
      ok: false,
      issues: legacyIssues.map((iss) => ({
        path: iss.path,
        message: iss.message,
      })),
    };
  }
  const validated = OpenClawSchema.safeParse(raw);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((issue) => mapZodIssueToConfigIssue(issue)),
    };
  }
  const duplicates = findDuplicateAgentDirs(validated.data as OpenClawConfig);
  if (duplicates.length > 0) {
    return {
      ok: false,
      issues: [
        {
          path: "agents.list",
          message: formatDuplicateAgentDirError(duplicates),
        },
      ],
    };
  }
  const avatarIssues = validateIdentityAvatar(validated.data as OpenClawConfig);
  if (avatarIssues.length > 0) {
    return { ok: false, issues: avatarIssues };
  }
  const gatewayTailscaleBindIssues = validateGatewayTailscaleBind(validated.data as OpenClawConfig);
  if (gatewayTailscaleBindIssues.length > 0) {
    return { ok: false, issues: gatewayTailscaleBindIssues };
  }
  const relayRoutingIssues = validateRelayRoutingProtectionLoops(validated.data as OpenClawConfig);
  if (relayRoutingIssues.length > 0) {
    return { ok: false, issues: relayRoutingIssues };
  }
  return {
    ok: true,
    config: validated.data as OpenClawConfig,
  };
}

export function validateConfigObject(
  raw: unknown,
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const result = validateConfigObjectRaw(raw);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    config: applyModelDefaults(applyAgentDefaults(applySessionDefaults(result.config))),
  };
}

export function validateConfigObjectWithPlugins(raw: unknown):
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    } {
  return validateConfigObjectWithPluginsBase(raw, { applyDefaults: true });
}

export function validateConfigObjectRawWithPlugins(raw: unknown):
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    } {
  return validateConfigObjectWithPluginsBase(raw, { applyDefaults: false });
}

function validateConfigObjectWithPluginsBase(
  raw: unknown,
  opts: { applyDefaults: boolean },
):
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    } {
  const base = opts.applyDefaults ? validateConfigObject(raw) : validateConfigObjectRaw(raw);
  if (!base.ok) {
    return { ok: false, issues: base.issues, warnings: [] };
  }

  const config = base.config;
  const issues: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];
  const hasExplicitPluginsConfig =
    isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, "plugins");

  const resolvePluginConfigIssuePath = (pluginId: string, errorPath: string): string => {
    const base = `plugins.entries.${pluginId}.config`;
    if (!errorPath || errorPath === "<root>") {
      return base;
    }
    return `${base}.${errorPath}`;
  };

  type RegistryInfo = {
    registry: ReturnType<typeof loadPluginManifestRegistry>;
    knownIds?: Set<string>;
    normalizedPlugins?: ReturnType<typeof normalizePluginsConfig>;
  };

  let registryInfo: RegistryInfo | null = null;

  const ensureRegistry = (): RegistryInfo => {
    if (registryInfo) {
      return registryInfo;
    }

    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    const registry = loadPluginManifestRegistry({
      config,
      workspaceDir: workspaceDir ?? undefined,
    });

    for (const diag of registry.diagnostics) {
      let path = diag.pluginId ? `plugins.entries.${diag.pluginId}` : "plugins";
      if (!diag.pluginId && diag.message.includes("plugin path not found")) {
        path = "plugins.load.paths";
      }
      const pluginLabel = diag.pluginId ? `plugin ${diag.pluginId}` : "plugin";
      const message = `${pluginLabel}: ${diag.message}`;
      if (diag.level === "error") {
        issues.push({ path, message });
      } else {
        warnings.push({ path, message });
      }
    }

    registryInfo = { registry };
    return registryInfo;
  };

  const ensureKnownIds = (): Set<string> => {
    const info = ensureRegistry();
    if (!info.knownIds) {
      info.knownIds = new Set(info.registry.plugins.map((record) => record.id));
    }
    return info.knownIds;
  };

  const ensureNormalizedPlugins = (): ReturnType<typeof normalizePluginsConfig> => {
    const info = ensureRegistry();
    if (!info.normalizedPlugins) {
      info.normalizedPlugins = normalizePluginsConfig(config.plugins);
    }
    return info.normalizedPlugins;
  };

  const allowedChannels = new Set<string>(["defaults", "modelByChannel", ...CHANNEL_IDS]);

  if (config.channels && isRecord(config.channels)) {
    for (const key of Object.keys(config.channels)) {
      const trimmed = key.trim();
      if (!trimmed) {
        continue;
      }
      if (!allowedChannels.has(trimmed)) {
        const { registry } = ensureRegistry();
        for (const record of registry.plugins) {
          for (const channelId of record.channels) {
            allowedChannels.add(channelId);
          }
        }
      }
      if (!allowedChannels.has(trimmed)) {
        issues.push({
          path: `channels.${trimmed}`,
          message: `unknown channel id: ${trimmed}`,
        });
      }
    }
  }

  const heartbeatChannelIds = new Set<string>();
  for (const channelId of CHANNEL_IDS) {
    heartbeatChannelIds.add(channelId.toLowerCase());
  }

  const validateHeartbeatTarget = (target: string | undefined, path: string) => {
    if (typeof target !== "string") {
      return;
    }
    const trimmed = target.trim();
    if (!trimmed) {
      issues.push({ path, message: "heartbeat target must not be empty" });
      return;
    }
    const normalized = trimmed.toLowerCase();
    if (normalized === "last" || normalized === "none") {
      return;
    }
    if (normalizeChatChannelId(trimmed)) {
      return;
    }
    if (!heartbeatChannelIds.has(normalized)) {
      const { registry } = ensureRegistry();
      for (const record of registry.plugins) {
        for (const channelId of record.channels) {
          const pluginChannel = channelId.trim();
          if (pluginChannel) {
            heartbeatChannelIds.add(pluginChannel.toLowerCase());
          }
        }
      }
    }
    if (heartbeatChannelIds.has(normalized)) {
      return;
    }
    issues.push({ path, message: `unknown heartbeat target: ${target}` });
  };

  validateHeartbeatTarget(
    config.agents?.defaults?.heartbeat?.target,
    "agents.defaults.heartbeat.target",
  );
  if (Array.isArray(config.agents?.list)) {
    for (const [index, entry] of config.agents.list.entries()) {
      validateHeartbeatTarget(entry?.heartbeat?.target, `agents.list.${index}.heartbeat.target`);
    }
  }

  const relayKnownChannels = new Set<string>(
    CHANNEL_IDS.map((channelId) => channelId.toLowerCase()),
  );
  let relayPluginChannelsLoaded = false;
  const ensureRelayPluginChannels = () => {
    if (relayPluginChannelsLoaded) {
      return;
    }
    relayPluginChannelsLoaded = true;
    const { registry } = ensureRegistry();
    for (const record of registry.plugins) {
      for (const channelId of record.channels) {
        const normalized = channelId.trim().toLowerCase();
        if (normalized) {
          relayKnownChannels.add(normalized);
        }
      }
    }
  };

  const relayTargets = config.session?.relayRouting?.targets;
  if (relayTargets && isRecord(relayTargets)) {
    for (const [targetKey, candidateTarget] of Object.entries(relayTargets)) {
      if (!candidateTarget || typeof candidateTarget !== "object") {
        continue;
      }
      const target = candidateTarget as RelayRoutingTargetRecord;
      const channel = target.channel?.trim() ?? "";
      if (!channel) {
        continue;
      }
      const normalizedChannel = normalizeRelayChannelId(channel);
      const basePath = `session.relayRouting.targets.${targetKey}`;
      let knownChannel = Boolean(normalizedChannel) && relayKnownChannels.has(normalizedChannel);
      if (!knownChannel && normalizedChannel) {
        ensureRelayPluginChannels();
        knownChannel = relayKnownChannels.has(normalizedChannel);
      }
      if (!knownChannel) {
        issues.push({
          path: `${basePath}.channel`,
          message: `unknown relay target channel: ${channel}`,
        });
        continue;
      }
      const destination = target.to?.trim() ?? "";
      if (!destination) {
        continue;
      }
      const destinationIssue = validateRelayTargetDestinationFormat({
        channel: normalizedChannel,
        destination,
      });
      if (destinationIssue) {
        issues.push({
          path: `${basePath}.to`,
          message: destinationIssue,
        });
      }
    }
  }

  if (!hasExplicitPluginsConfig) {
    if (issues.length > 0) {
      return { ok: false, issues, warnings };
    }
    return { ok: true, config, warnings };
  }

  const { registry } = ensureRegistry();
  const knownIds = ensureKnownIds();
  const normalizedPlugins = ensureNormalizedPlugins();
  const pushMissingPluginIssue = (
    path: string,
    pluginId: string,
    opts?: { warnOnly?: boolean },
  ) => {
    if (LEGACY_REMOVED_PLUGIN_IDS.has(pluginId)) {
      warnings.push({
        path,
        message: `plugin removed: ${pluginId} (stale config entry ignored; remove it from plugins config)`,
      });
      return;
    }
    if (opts?.warnOnly) {
      warnings.push({
        path,
        message: `plugin not found: ${pluginId} (stale config entry ignored; remove it from plugins config)`,
      });
      return;
    }
    issues.push({
      path,
      message: `plugin not found: ${pluginId}`,
    });
  };

  const pluginsConfig = config.plugins;

  const entries = pluginsConfig?.entries;
  if (entries && isRecord(entries)) {
    for (const pluginId of Object.keys(entries)) {
      if (!knownIds.has(pluginId)) {
        // Keep gateway startup resilient when plugins are removed/renamed across upgrades.
        pushMissingPluginIssue(`plugins.entries.${pluginId}`, pluginId, { warnOnly: true });
      }
    }
  }

  const allow = pluginsConfig?.allow ?? [];
  for (const pluginId of allow) {
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      continue;
    }
    if (!knownIds.has(pluginId)) {
      pushMissingPluginIssue("plugins.allow", pluginId);
    }
  }

  const deny = pluginsConfig?.deny ?? [];
  for (const pluginId of deny) {
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      continue;
    }
    if (!knownIds.has(pluginId)) {
      pushMissingPluginIssue("plugins.deny", pluginId);
    }
  }

  const memorySlot = normalizedPlugins.slots.memory;
  if (typeof memorySlot === "string" && memorySlot.trim() && !knownIds.has(memorySlot)) {
    pushMissingPluginIssue("plugins.slots.memory", memorySlot);
  }

  let selectedMemoryPluginId: string | null = null;
  const seenPlugins = new Set<string>();
  for (const record of registry.plugins) {
    const pluginId = record.id;
    if (seenPlugins.has(pluginId)) {
      continue;
    }
    seenPlugins.add(pluginId);
    const entry = normalizedPlugins.entries[pluginId];
    const entryHasConfig = Boolean(entry?.config);

    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: config,
    });
    let enabled = enableState.enabled;
    let reason = enableState.reason;

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
      if (memoryDecision.selected && record.kind === "memory") {
        selectedMemoryPluginId = pluginId;
      }
    }

    const shouldValidate = enabled || entryHasConfig;
    if (shouldValidate) {
      if (record.configSchema) {
        const res = validateJsonSchemaValue({
          schema: record.configSchema,
          cacheKey: record.schemaCacheKey ?? record.manifestPath ?? pluginId,
          value: entry?.config ?? {},
        });
        if (!res.ok) {
          for (const error of res.errors) {
            issues.push({
              path: resolvePluginConfigIssuePath(pluginId, error.path),
              message: `invalid config: ${error.message}`,
              allowedValues: error.allowedValues,
              allowedValuesHiddenCount: error.allowedValuesHiddenCount,
            });
          }
        }
      } else {
        issues.push({
          path: `plugins.entries.${pluginId}`,
          message: `plugin schema missing for ${pluginId}`,
        });
      }
    }

    if (!enabled && entryHasConfig) {
      warnings.push({
        path: `plugins.entries.${pluginId}`,
        message: `plugin disabled (${reason ?? "disabled"}) but config is present`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, warnings };
  }

  return { ok: true, config, warnings };
}
