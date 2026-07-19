// Gateway config reload planner.
// Maps changed config paths to hot-reload actions, no-ops, or full restarts.
import {
  type ChannelId,
  type ChannelPlugin,
  listChannelPlugins,
} from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizePluginsConfigWithResolver,
  resolveEffectivePluginActivationState,
} from "../plugins/config-policy.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isPluginEnabledByDefaultForPlatform } from "../plugins/default-enablement.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizePluginPolicyId } from "../plugins/plugin-policy-id.js";
import {
  getActivePluginChannelRegistryVersion,
  getActivePluginHttpRouteRegistry,
  getActivePluginHttpRouteRegistryVersion,
} from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
import { isPlainObject } from "../utils.js";

export type ChannelKind = ChannelId;

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  restartGmailWatcher: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  restartHealthMonitor: boolean;
  reloadPlugins: boolean;
  restartChannels: Set<ChannelKind>;
  disposeMcpRuntimes: boolean;
  /** Account targets; absent means no targeted restarts for hand-built plans. */
  restartChannelAccounts?: Map<ChannelKind, Set<string>>;
  noopPaths: string[];
};

type ReloadRule = {
  prefix: string;
  kind: "restart" | "hot" | "none";
  actions?: ReloadAction[];
  accountScopedPlugin?: ChannelPlugin;
};

type ConfigReloadMetadata = {
  kind: ReloadRule["kind"];
};

type ReloadAction =
  | "reload-hooks"
  | "restart-gmail-watcher"
  | "restart-cron"
  | "restart-heartbeat"
  | "restart-health-monitor"
  | "reload-plugins"
  | "dispose-mcp-runtimes"
  | `restart-channel-account:${ChannelId}`
  | `restart-channel:${ChannelId}`;

type GatewayReloadPlanOptions = {
  noopPaths?: Iterable<string>;
  forceChangedPaths?: Iterable<string>;
  /** Candidate config used to reject removed, unknown, or unresolvable account targets. */
  candidateConfig?: OpenClawConfig;
  previousConfig?: OpenClawConfig;
  nextConfig?: OpenClawConfig;
  pluginMetadataSnapshot?: PolicyActivationMetadataSnapshot | null;
};

type PolicyActivationMetadataSnapshot = Pick<
  PluginMetadataSnapshot,
  "normalizePluginId" | "pluginIds" | "plugins"
>;

const PLUGIN_INSTALL_TIMESTAMP_KEYS = ["installedAt", "resolvedAt"] as const;
const PLUGIN_AUTHORIZATION_RESTART_RULE: ReloadRule = {
  prefix: "plugins.entries.<id>.authorization",
  kind: "restart",
};
const PLUGIN_ACTIVATION_RESTART_RULE: ReloadRule = {
  prefix: "plugins.<activation>",
  kind: "restart",
};
const PLUGIN_ACTIVATION_PREFIXES = [
  "plugins.enabled",
  "plugins.allow",
  "plugins.deny",
  "plugins.slots",
  "plugins.bundledDiscovery",
] as const;
const PLUGIN_ENTRY_PREFIX = "plugins.entries.";

const BASE_RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
  // gateway.terminal.* deliberately has no rule here: it falls through to the
  // `gateway` restart rule below. The terminal drives the Control UI CSP (WASM
  // permissions) and the bootstrap availability flag, both fixed at document
  // load, plus live PTYs — none can hot-update a connected client, so a change
  // must restart the gateway (clients reconnect with a fresh page and CSP).
  {
    prefix: "gateway.channelHealthCheckMinutes",
    kind: "hot",
    actions: ["restart-health-monitor"],
  },
  {
    prefix: "gateway.channelStaleEventThresholdMinutes",
    kind: "hot",
    actions: ["restart-health-monitor"],
  },
  {
    prefix: "gateway.channelMaxRestartsPerHour",
    kind: "hot",
    actions: ["restart-health-monitor"],
  },
  // Diagnostics heartbeat reads these from current runtime config.
  { prefix: "diagnostics.stuckSessionWarnMs", kind: "none" },
  { prefix: "diagnostics.stuckSessionAbortMs", kind: "none" },
  { prefix: "diagnostics.memoryPressureSnapshot", kind: "hot" },
  { prefix: "hooks.gmail", kind: "hot", actions: ["restart-gmail-watcher"] },
  { prefix: "hooks", kind: "hot", actions: ["reload-hooks"] },
  {
    prefix: "agents.defaults.heartbeat",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.defaults.models",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.defaults.modelPolicy",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.defaults.model",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "models.pricing",
    kind: "restart",
  },
  {
    prefix: "models",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  // Auth cooldown readers resolve values from the active runtime config for each
  // auth failure decision, so cooldown tuning needs a snapshot refresh but not
  // a gateway restart.
  { prefix: "auth.cooldowns", kind: "hot" },
  // Worktree cleanup limits are read from the runtime config at each gc pass
  // (hourly sweep and worktrees.gc), so a Settings stepper edit needs only a
  // snapshot refresh; a restart here would drop live sessions per click.
  { prefix: "worktrees", kind: "hot" },
  {
    prefix: "agents.list",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
  // The dedicated Apps listener and origin are created once during Gateway
  // startup; disposing MCP runtimes cannot move or create that HTTP server.
  { prefix: "mcp.apps", kind: "restart" },
  { prefix: "mcp", kind: "hot", actions: ["dispose-mcp-runtimes"] },
  { prefix: "plugins.load", kind: "restart" },
  { prefix: "plugins.installs", kind: "restart" },
];

const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { prefix: "meta", kind: "none" },
  { prefix: "identity", kind: "none" },
  { prefix: "wizard", kind: "none" },
  { prefix: "logging", kind: "none" },
  { prefix: "agents", kind: "none" },
  { prefix: "tools", kind: "none" },
  { prefix: "bindings", kind: "none" },
  { prefix: "audio", kind: "none" },
  { prefix: "agent", kind: "none" },
  { prefix: "routing", kind: "none" },
  { prefix: "messages", kind: "none" },
  { prefix: "session", kind: "none" },
  { prefix: "talk", kind: "none" },
  { prefix: "skills", kind: "none" },
  { prefix: "secrets", kind: "none" },
  { prefix: "plugins", kind: "hot", actions: ["reload-plugins", "dispose-mcp-runtimes"] },
  { prefix: "tui", kind: "none" },
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedAuthorizationPolicyPluginIds = new Set<string>();
let cachedRegistry: ReturnType<typeof getActivePluginHttpRouteRegistry> | null = null;
let cachedGatewayRegistryVersion = -1;
let cachedChannelRegistryVersion = -1;

function listReloadRules(): ReloadRule[] {
  // Reload metadata is Gateway policy. Agent-scoped registry activation must
  // not replace the pinned Gateway surface and silently change restart rules.
  const registry = getActivePluginHttpRouteRegistry();
  const gatewayRegistryVersion = getActivePluginHttpRouteRegistryVersion();
  const channelRegistryVersion = getActivePluginChannelRegistryVersion();
  // Plugin/channel reload rules are process-stable until the active registry
  // version changes; cache them to keep every config diff cheap.
  if (
    registry !== cachedRegistry ||
    gatewayRegistryVersion !== cachedGatewayRegistryVersion ||
    channelRegistryVersion !== cachedChannelRegistryVersion
  ) {
    cachedReloadRules = null;
    cachedRegistry = registry;
    cachedGatewayRegistryVersion = gatewayRegistryVersion;
    cachedChannelRegistryVersion = channelRegistryVersion;
  }
  if (cachedReloadRules) {
    return cachedReloadRules;
  }
  const authorizationPolicyPluginIds = new Set<string>();
  for (const plugin of registry?.plugins ?? []) {
    if ((plugin.contracts?.authorizationPolicies?.length ?? 0) > 0) {
      authorizationPolicyPluginIds.add(normalizePluginPolicyId(plugin.id));
    }
  }
  for (const registration of registry?.authorizationPolicies ?? []) {
    authorizationPolicyPluginIds.add(normalizePluginPolicyId(registration.pluginId));
  }
  cachedAuthorizationPolicyPluginIds = new Set([...authorizationPolicyPluginIds].filter(Boolean));
  // Channel docking: plugins contribute hot reload/no-op prefixes here.
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => {
    const restartAction = plugin.reload?.accountScopedRestart
      ? (`restart-channel-account:${plugin.id}` as ReloadAction)
      : (`restart-channel:${plugin.id}` as ReloadAction);
    return (plugin.reload?.configPrefixes ?? [])
      .map((prefix): ReloadRule => {
        const rule: ReloadRule = {
          prefix,
          kind: "hot",
          actions: [restartAction],
        };
        if (plugin.reload?.accountScopedRestart) {
          rule.accountScopedPlugin = plugin;
        }
        return rule;
      })
      .concat(
        (plugin.reload?.noopPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "none",
          }),
        ),
      );
  });
  const channelPluginStateRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => [
    {
      prefix: `plugins.entries.${plugin.id}`,
      kind: "hot",
      actions: [
        "reload-plugins",
        "dispose-mcp-runtimes",
        `restart-channel:${plugin.id}` as ReloadAction,
      ],
    },
  ]);
  const pluginReloadRules: ReloadRule[] = (registry?.reloads ?? []).flatMap((entry) =>
    (entry.registration.restartPrefixes ?? [])
      .map(
        (prefix): ReloadRule => ({
          prefix,
          kind: "restart",
        }),
      )
      .concat(
        (entry.registration.hotPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "hot",
          }),
        ),
        (entry.registration.noopPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "none",
          }),
        ),
      ),
  );
  const rules = [
    ...BASE_RELOAD_RULES,
    ...pluginReloadRules,
    ...channelReloadRules,
    ...channelPluginStateRules,
    ...BASE_RELOAD_RULES_TAIL,
  ];
  // Narrow config contracts must override broad owner fallbacks. Sort once per
  // registry snapshot so the hot path can retain first-match semantics.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  cachedReloadRules = rules;
  return rules;
}

function configuredPluginEntryIds(options: GatewayReloadPlanOptions): Set<string> | undefined {
  if (!options.previousConfig && !options.nextConfig) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const config of [options.previousConfig, options.nextConfig]) {
    const entries = config?.plugins?.entries;
    if (!isPlainObject(entries)) {
      continue;
    }
    for (const id of Object.keys(entries)) {
      ids.add(id);
    }
  }
  return ids;
}

function isPluginEntryActivationPath(path: string, pluginEntryIds?: ReadonlySet<string>): boolean {
  if (path === "plugins.entries") {
    return true;
  }
  if (!path.startsWith(PLUGIN_ENTRY_PREFIX)) {
    return false;
  }
  if (pluginEntryIds) {
    for (const id of pluginEntryIds) {
      const entryPath = `${PLUGIN_ENTRY_PREFIX}${id}`;
      if (path === entryPath || path === `${entryPath}.enabled`) {
        return true;
      }
    }
    return false;
  }
  // Metadata-only callers have no config keys to disambiguate dotted ids from
  // nested config. Preserve the historical single-segment fallback there.
  const remainder = path.slice(PLUGIN_ENTRY_PREFIX.length);
  const firstDot = remainder.indexOf(".");
  return firstDot === -1 || (firstDot > 0 && remainder.slice(firstDot) === ".enabled");
}

function isPluginActivationPath(path: string, pluginEntryIds?: ReadonlySet<string>): boolean {
  return (
    isPluginEntryActivationPath(path, pluginEntryIds) ||
    PLUGIN_ACTIVATION_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))
  );
}

function isAuthorizationPolicyPluginEntryPath(
  path: string,
  options?: {
    pluginEntryIds?: ReadonlySet<string>;
    normalizePluginId?: PolicyActivationMetadataSnapshot["normalizePluginId"];
  },
): boolean {
  const pluginEntryIds = options?.pluginEntryIds;
  if (
    cachedAuthorizationPolicyPluginIds.size === 0 ||
    !pluginEntryIds ||
    !path.startsWith(PLUGIN_ENTRY_PREFIX)
  ) {
    return false;
  }
  let configuredId: string | undefined;
  for (const id of pluginEntryIds) {
    const entryPath = `${PLUGIN_ENTRY_PREFIX}${id}`;
    if (
      (path === entryPath || path.startsWith(`${entryPath}.`)) &&
      (configuredId === undefined || id.length > configuredId.length)
    ) {
      configuredId = id;
    }
  }
  if (!configuredId) {
    return false;
  }
  if (cachedAuthorizationPolicyPluginIds.has(normalizePluginPolicyId(configuredId))) {
    return true;
  }
  // A missing or failed startup resolver cannot prove this key is unrelated.
  if (!options?.normalizePluginId) {
    return true;
  }
  try {
    const normalizedId = normalizePluginPolicyId(options.normalizePluginId(configuredId));
    return !normalizedId || cachedAuthorizationPolicyPluginIds.has(normalizedId);
  } catch {
    return true;
  }
}

function resolvePolicyActivationMetadataSnapshot(
  options: GatewayReloadPlanOptions,
): PolicyActivationMetadataSnapshot | undefined {
  if (options.pluginMetadataSnapshot !== undefined) {
    return options.pluginMetadataSnapshot ?? undefined;
  }
  return getCurrentPluginMetadataSnapshot({ allowWorkspaceScopedSnapshot: true });
}

function configActivatesAuthorizationPolicy(params: {
  config: OpenClawConfig;
  snapshot: PolicyActivationMetadataSnapshot;
}): boolean {
  const normalizedConfig = normalizePluginsConfigWithResolver(
    params.config.plugins,
    params.snapshot.normalizePluginId,
  );
  return params.snapshot.plugins.some((plugin) => {
    if ((plugin.contracts?.authorizationPolicies?.length ?? 0) === 0) {
      return false;
    }
    const activation = resolveEffectivePluginActivationState({
      id: plugin.id,
      origin: plugin.origin,
      config: normalizedConfig,
      rootConfig: params.config,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
    });
    return activation.enabled && (plugin.origin === "bundled" || activation.explicitlyEnabled);
  });
}

function canHotReloadPluginActivation(
  changedPaths: readonly string[],
  options: GatewayReloadPlanOptions,
  snapshot: PolicyActivationMetadataSnapshot | undefined,
): boolean {
  const pluginEntryIds = configuredPluginEntryIds(options);
  if (
    !changedPaths.some((path) => isPluginActivationPath(path, pluginEntryIds)) ||
    !options.previousConfig ||
    !options.nextConfig
  ) {
    return false;
  }
  // Changing discovery mode can expose manifests outside the current snapshot,
  // so no existing inventory can prove the next activation set policy-free.
  if (
    changedPaths.some(
      (path) => path === "plugins.bundledDiscovery" || path.startsWith("plugins.bundledDiscovery."),
    )
  ) {
    return false;
  }
  // Scoped startup snapshots omit inactive plugins. Only a complete discovered
  // inventory can prove that both activation sets contain no policy owner.
  if (!snapshot || snapshot.pluginIds !== undefined) {
    return false;
  }
  const activeRegistry = getActivePluginHttpRouteRegistry();
  if ((activeRegistry?.authorizationPolicies?.length ?? 0) > 0) {
    return false;
  }
  return ![options.previousConfig, options.nextConfig].some((config) =>
    configActivatesAuthorizationPolicy({ config, snapshot }),
  );
}

function matchRule(
  path: string,
  options?: {
    allowPluginActivationHotReload?: boolean;
    pluginEntryIds?: ReadonlySet<string>;
    normalizePluginId?: PolicyActivationMetadataSnapshot["normalizePluginId"];
  },
): ReloadRule | null {
  // Required policies and their registered handlers form one startup security
  // boundary. Never replace only the config half through ordinary plugin reload.
  if (/^plugins\.entries\..+\.authorization(?:$|\.requiredPolicies(?:\.|$))/.test(path)) {
    return PLUGIN_AUTHORIZATION_RESTART_RULE;
  }
  const rules = listReloadRules();
  if (
    isPluginActivationPath(path, options?.pluginEntryIds) &&
    options?.allowPluginActivationHotReload !== true
  ) {
    return PLUGIN_ACTIVATION_RESTART_RULE;
  }
  if (isAuthorizationPolicyPluginEntryPath(path, options)) {
    return PLUGIN_AUTHORIZATION_RESTART_RULE;
  }
  // A policy plugin's entire entry feeds its startup handler registration.
  // Plugin-declared hot prefixes must not replace that handler in process.
  for (const pluginId of cachedAuthorizationPolicyPluginIds) {
    const prefix = `plugins.entries.${pluginId}`;
    if (path === prefix || path.startsWith(`${prefix}.`)) {
      return PLUGIN_AUTHORIZATION_RESTART_RULE;
    }
  }
  for (const rule of rules) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      return rule;
    }
  }
  return null;
}

export function resolveConfigReloadMetadata(path: string): ConfigReloadMetadata {
  if (isPluginInstallTimestampPath(path)) {
    return { kind: "none" };
  }
  return { kind: matchRule(path)?.kind ?? "restart" };
}

function isPluginInstallTimestampPath(path: string): boolean {
  // Legacy compatibility only: new plugin install metadata lives in the
  // managed plugin index, but old config writes may still touch this path.
  return /^plugins\.installs\..+\.(installedAt|resolvedAt)$/.test(path);
}

function getPluginInstallRecords(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    return {};
  }
  const plugins = config.plugins;
  if (!isPlainObject(plugins)) {
    return {};
  }
  // Keep legacy config install records out of gateway restart decisions while
  // migration/doctor moves them into the managed plugin index install records.
  const installs = plugins.installs;
  return isPlainObject(installs) ? installs : {};
}

function listPluginInstallRecordDiffPaths(
  prevConfig: unknown,
  nextConfig: unknown,
  visit: (record: {
    id: string;
    prevRecord: unknown;
    nextRecord: unknown;
    paths: string[];
  }) => void,
): string[] {
  const prevInstalls = getPluginInstallRecords(prevConfig);
  const nextInstalls = getPluginInstallRecords(nextConfig);
  const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
  const paths: string[] = [];

  for (const id of ids) {
    visit({ id, prevRecord: prevInstalls[id], nextRecord: nextInstalls[id], paths });
  }

  return paths;
}

export function listPluginInstallTimestampMetadataPaths(
  prevConfig: unknown,
  nextConfig: unknown,
): string[] {
  return listPluginInstallRecordDiffPaths(
    prevConfig,
    nextConfig,
    ({ id, prevRecord, nextRecord, paths }) => {
      if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
        return;
      }
      for (const key of PLUGIN_INSTALL_TIMESTAMP_KEYS) {
        if (prevRecord[key] !== nextRecord[key]) {
          paths.push(`plugins.installs.${id}.${key}`);
        }
      }
    },
  );
}

export function listPluginInstallWholeRecordPaths(
  prevConfig: unknown,
  nextConfig: unknown,
): string[] {
  return listPluginInstallRecordDiffPaths(
    prevConfig,
    nextConfig,
    ({ id, prevRecord, nextRecord, paths }) => {
      if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
        paths.push(`plugins.installs.${id}`);
      }
    },
  );
}

function extractAccountIdFromPath(channel: ChannelId, path: string): string | null {
  const prefix = `channels.${channel}.accounts.`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rest = path.slice(prefix.length);
  if (rest.length === 0) {
    return null;
  }
  const dotIdx = rest.indexOf(".");
  const id = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
  if (id.length === 0) {
    return null;
  }
  // Default config is the inheritance base, so it can change every account.
  if (id === DEFAULT_ACCOUNT_ID) {
    return null;
  }
  return id;
}

function isResolvableChannelAccount(params: {
  plugin: ChannelPlugin | undefined;
  accountId: string;
  config: OpenClawConfig;
}): boolean {
  if (!params.plugin) {
    return false;
  }
  try {
    if (!params.plugin.config.listAccountIds(params.config).includes(params.accountId)) {
      return false;
    }
    params.plugin.config.resolveAccount(params.config, params.accountId);
    return true;
  } catch {
    return false;
  }
}

export function buildGatewayReloadPlan(
  changedPaths: string[],
  options: GatewayReloadPlanOptions = {},
): GatewayReloadPlan {
  const noopPaths = new Set(options.noopPaths);
  const forceChangedPaths = new Set(options.forceChangedPaths);
  const restartChannelAccounts = new Map<ChannelKind, Set<string>>();
  const pluginEntryIds = configuredPluginEntryIds(options);
  const policyActivationMetadataSnapshot =
    pluginEntryIds !== undefined ? resolvePolicyActivationMetadataSnapshot(options) : undefined;
  const allowPluginActivationHotReload = canHotReloadPluginActivation(
    changedPaths,
    options,
    policyActivationMetadataSnapshot,
  );
  const plan: GatewayReloadPlan = {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    restartChannelAccounts,
    noopPaths: [],
  };

  const applyAction = (
    action: ReloadAction,
    originatingPath: string,
    accountScopedPlugin?: ChannelPlugin,
  ) => {
    if (action.startsWith("restart-channel-account:")) {
      const channel = action.slice("restart-channel-account:".length) as ChannelId;
      const accountId = extractAccountIdFromPath(channel, originatingPath);
      if (accountId !== null) {
        if (
          options.candidateConfig &&
          !isResolvableChannelAccount({
            plugin: accountScopedPlugin,
            accountId,
            config: options.candidateConfig,
          })
        ) {
          plan.restartChannels.add(channel);
          return;
        }
        let set = restartChannelAccounts.get(channel);
        if (!set) {
          set = new Set<string>();
          restartChannelAccounts.set(channel, set);
        }
        set.add(accountId);
        return;
      }
      plan.restartChannels.add(channel);
      return;
    }
    if (action.startsWith("restart-channel:")) {
      const channel = action.slice("restart-channel:".length) as ChannelId;
      plan.restartChannels.add(channel);
      return;
    }
    switch (action) {
      case "reload-hooks":
        plan.reloadHooks = true;
        break;
      case "restart-gmail-watcher":
        plan.restartGmailWatcher = true;
        break;
      case "restart-cron":
        plan.restartCron = true;
        break;
      case "restart-heartbeat":
        plan.restartHeartbeat = true;
        break;
      case "restart-health-monitor":
        plan.restartHealthMonitor = true;
        break;
      case "reload-plugins":
        plan.reloadPlugins = true;
        break;
      case "dispose-mcp-runtimes":
        plan.disposeMcpRuntimes = true;
        break;
      default:
        break;
    }
  };

  for (const path of changedPaths) {
    const isTimestampNoop =
      !forceChangedPaths.has(path) &&
      (noopPaths.size > 0 ? noopPaths.has(path) : isPluginInstallTimestampPath(path));
    if (isTimestampNoop) {
      plan.noopPaths.push(path);
      continue;
    }
    const rule = matchRule(path, {
      allowPluginActivationHotReload,
      pluginEntryIds,
      normalizePluginId: policyActivationMetadataSnapshot?.normalizePluginId,
    });
    if (!rule) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "restart") {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule.actions ?? []) {
      applyAction(action, path, rule.accountScopedPlugin);
    }
  }

  // A wholesale restart covers its account targets and must run only once.
  for (const channel of plan.restartChannels) {
    restartChannelAccounts.delete(channel);
  }

  if (plan.restartGmailWatcher) {
    plan.reloadHooks = true;
  }

  return plan;
}
