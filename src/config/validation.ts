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
type ConfigPathSegment = string | number;

const SUBAGENT_ALLOW_ALIAS_KEYS = new Set(["allow", "allowlist"]);
const AGENT_DEFAULTS_ENTRY_ONLY_KEYS = new Set([
  "id",
  "name",
  "default",
  "workspace",
  "agentDir",
  "tools",
  "identity",
  "groupChat",
  "runtime",
]);

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

function normalizeIssuePathSegments(record: UnknownIssueRecord | null): ConfigPathSegment[] {
  return Array.isArray(record?.path)
    ? record.path.filter((segment): segment is ConfigPathSegment => {
        const segmentType = typeof segment;
        return segmentType === "string" || segmentType === "number";
      })
    : [];
}

function stringifyIssuePath(segments: ConfigPathSegment[]): string {
  return segments.join(".");
}

function getUnrecognizedKeys(record: UnknownIssueRecord | null): string[] {
  return Array.isArray(record?.keys)
    ? record.keys.filter((key): key is string => typeof key === "string")
    : [];
}

function quoteIssueKeys(keys: string[]): string {
  if (keys.length === 0) {
    return "";
  }
  if (keys.length === 1) {
    return `"${keys[0]}"`;
  }
  return keys.map((key) => `"${key}"`).join(", ");
}

function getRemainingUnrecognizedKeys(keys: string[], handledKeys: string[]): string[] {
  if (handledKeys.length === 0) {
    return keys;
  }
  const handled = new Set(handledKeys);
  return keys.filter((key) => !handled.has(key));
}

function formatRemainingUnrecognizedKeysSuffix(keys: string[]): string {
  if (keys.length === 0) {
    return "";
  }
  return ` Also remove unsupported ${keys.length === 1 ? "key" : "keys"} ${quoteIssueKeys(keys)}.`;
}

function resolveCustomConfigIssueForUnrecognizedKeys(
  record: UnknownIssueRecord | null,
  pathSegments: ConfigPathSegment[],
): ConfigValidationIssue | null {
  if (record?.code !== "unrecognized_keys") {
    return null;
  }

  const keys = getUnrecognizedKeys(record);
  if (keys.length === 0) {
    return null;
  }

  const path = stringifyIssuePath(pathSegments);
  const isAgentsListSubagentsPath =
    pathSegments.length === 4 &&
    pathSegments[0] === "agents" &&
    pathSegments[1] === "list" &&
    typeof pathSegments[2] === "number" &&
    pathSegments[3] === "subagents";
  if (isAgentsListSubagentsPath) {
    const aliasKeys = keys.filter((key) => SUBAGENT_ALLOW_ALIAS_KEYS.has(key));
    if (aliasKeys.length > 0) {
      const remainingKeys = getRemainingUnrecognizedKeys(keys, aliasKeys);
      return {
        path:
          aliasKeys.length === 1 && remainingKeys.length === 0 ? `${path}.${aliasKeys[0]}` : path,
        message:
          `Use agents.list[].subagents.allowAgents to allow target agent ids ("*" allows any). ` +
          `${quoteIssueKeys(aliasKeys)} ${aliasKeys.length === 1 ? "is" : "are"} not valid under subagents.` +
          formatRemainingUnrecognizedKeysSuffix(remainingKeys),
      };
    }
  }

  const isAgentsDefaultsSubagentsPath =
    pathSegments.length === 3 &&
    pathSegments[0] === "agents" &&
    pathSegments[1] === "defaults" &&
    pathSegments[2] === "subagents";
  if (isAgentsDefaultsSubagentsPath) {
    const misplacedAllowKeys = keys.filter(
      (key) => key === "allowAgents" || SUBAGENT_ALLOW_ALIAS_KEYS.has(key),
    );
    if (misplacedAllowKeys.length > 0) {
      const remainingKeys = getRemainingUnrecognizedKeys(keys, misplacedAllowKeys);
      return {
        path:
          misplacedAllowKeys.length === 1 && remainingKeys.length === 0
            ? `${path}.${misplacedAllowKeys[0]}`
            : path,
        message:
          "agents.defaults.subagents does not accept per-agent target allowlists. " +
          "Put allowAgents on each caller agent under agents.list[].subagents.allowAgents. " +
          "defaults.subagents is only for spawned-agent defaults like model, thinking, depth/concurrency, and timeout/archive settings." +
          formatRemainingUnrecognizedKeysSuffix(remainingKeys),
      };
    }
  }

  const isAgentsDefaultsPath =
    pathSegments.length === 2 && pathSegments[0] === "agents" && pathSegments[1] === "defaults";
  if (isAgentsDefaultsPath) {
    const entryOnlyKeys = keys.filter((key) => AGENT_DEFAULTS_ENTRY_ONLY_KEYS.has(key));
    if (entryOnlyKeys.length > 0) {
      const remainingKeys = getRemainingUnrecognizedKeys(keys, entryOnlyKeys);
      return {
        path,
        message:
          `agents.defaults is for shared defaults only; received unsupported per-agent keys ${quoteIssueKeys(entryOnlyKeys)}. ` +
          "Move per-agent fields into agents.list[] entries, and configure tool policy at top-level tools.*." +
          formatRemainingUnrecognizedKeysSuffix(remainingKeys),
      };
    }
  }

  return null;
}

function mapZodIssueToConfigIssue(issue: unknown): ConfigValidationIssue {
  const record = toIssueRecord(issue);
  const pathSegments = normalizeIssuePathSegments(record);
  const path = stringifyIssuePath(pathSegments);
  const customIssue = resolveCustomConfigIssueForUnrecognizedKeys(record, pathSegments);
  if (customIssue) {
    return customIssue;
  }
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

type ValidateConfigWithPluginsResult =
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    };

export function validateConfigObjectWithPlugins(
  raw: unknown,
  params?: { env?: NodeJS.ProcessEnv },
): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginsBase(raw, { applyDefaults: true, env: params?.env });
}

export function validateConfigObjectRawWithPlugins(
  raw: unknown,
  params?: { env?: NodeJS.ProcessEnv },
): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginsBase(raw, { applyDefaults: false, env: params?.env });
}

function validateConfigObjectWithPluginsBase(
  raw: unknown,
  opts: { applyDefaults: boolean; env?: NodeJS.ProcessEnv },
): ValidateConfigWithPluginsResult {
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
      env: opts.env,
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
