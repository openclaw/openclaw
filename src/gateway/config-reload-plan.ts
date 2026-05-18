import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistry,
  getActivePluginRegistryVersion,
} from "../plugins/runtime.js";
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
  noopPaths: string[];
};

type ReloadRule = {
  prefix: string;
  kind: "restart" | "hot" | "none";
  actions?: ReloadAction[];
};

type ReloadAction =
  | "reload-hooks"
  | "restart-gmail-watcher"
  | "restart-cron"
  | "restart-heartbeat"
  | "restart-health-monitor"
  | "reload-plugins"
  | "dispose-mcp-runtimes"
  | `restart-channel:${ChannelId}`;

type GatewayReloadPlanOptions = {
  noopPaths?: Iterable<string>;
  forceChangedPaths?: Iterable<string>;
};

const BASE_RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
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
  {
    prefix: "agents.list",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
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
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let cachedActiveRegistryVersion = -1;
let cachedChannelRegistryVersion = -1;

function listReloadRules(): ReloadRule[] {
  const registry = getActivePluginRegistry();
  const activeRegistryVersion = getActivePluginRegistryVersion();
  const channelRegistryVersion = getActivePluginChannelRegistryVersion();
  if (
    registry !== cachedRegistry ||
    activeRegistryVersion !== cachedActiveRegistryVersion ||
    channelRegistryVersion !== cachedChannelRegistryVersion
  ) {
    cachedReloadRules = null;
    cachedRegistry = registry;
    cachedActiveRegistryVersion = activeRegistryVersion;
    cachedChannelRegistryVersion = channelRegistryVersion;
  }
  if (cachedReloadRules) {
    return cachedReloadRules;
  }
  // Channel docking: plugins contribute hot reload/no-op prefixes here.
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) =>
    (plugin.reload?.configPrefixes ?? [])
      .map(
        (prefix): ReloadRule => ({
          prefix,
          kind: "hot",
          actions: [`restart-channel:${plugin.id}` as ReloadAction],
        }),
      )
      .concat(
        (plugin.reload?.noopPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "none",
          }),
        ),
      ),
  );
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
  cachedReloadRules = rules;
  return rules;
}

function matchRule(path: string): ReloadRule | null {
  for (const rule of listReloadRules()) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      return rule;
    }
  }
  return null;
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

export function listPluginInstallTimestampMetadataPaths(
  prevConfig: unknown,
  nextConfig: unknown,
): string[] {
  const prevInstalls = getPluginInstallRecords(prevConfig);
  const nextInstalls = getPluginInstallRecords(nextConfig);
  const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
  const paths: string[] = [];

  for (const id of ids) {
    const prevRecord = prevInstalls[id];
    const nextRecord = nextInstalls[id];
    if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
      continue;
    }
    for (const key of ["installedAt", "resolvedAt"] as const) {
      if (prevRecord[key] !== nextRecord[key]) {
        paths.push(`plugins.installs.${id}.${key}`);
      }
    }
  }

  return paths;
}

export function listPluginInstallWholeRecordPaths(
  prevConfig: unknown,
  nextConfig: unknown,
): string[] {
  const prevInstalls = getPluginInstallRecords(prevConfig);
  const nextInstalls = getPluginInstallRecords(nextConfig);
  const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
  const paths: string[] = [];

  for (const id of ids) {
    const prevRecord = prevInstalls[id];
    const nextRecord = nextInstalls[id];
    if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
      paths.push(`plugins.installs.${id}`);
    }
  }

  return paths;
}

export function buildGatewayReloadPlan(
  changedPaths: string[],
  options: GatewayReloadPlanOptions = {},
): GatewayReloadPlan {
  const noopPaths = new Set(options.noopPaths);
  const forceChangedPaths = new Set(options.forceChangedPaths);
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
    noopPaths: [],
  };

  const applyAction = (action: ReloadAction) => {
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
    const rule = matchRule(path);
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
      applyAction(action);
    }
  }

  if (plan.restartGmailWatcher) {
    plan.reloadHooks = true;
  }

  return plan;
}

function readChannelEnabled(config: OpenClawConfig, channelId: string): unknown {
  const channels = isPlainObject(config.channels) ? config.channels : null;
  const channelCfg = channels && isPlainObject(channels[channelId]) ? channels[channelId] : null;
  return channelCfg?.enabled;
}

function readChannelAccountEnabled(
  config: OpenClawConfig,
  channelId: string,
  accountId: string,
): unknown {
  const channels = isPlainObject(config.channels) ? config.channels : null;
  const channelCfg = channels && isPlainObject(channels[channelId]) ? channels[channelId] : null;
  const accounts = channelCfg && isPlainObject(channelCfg.accounts) ? channelCfg.accounts : null;
  const accountCfg = accounts && isPlainObject(accounts[accountId]) ? accounts[accountId] : null;
  return accountCfg?.enabled;
}

function hasChannelConfig(config: OpenClawConfig, channelId: string): boolean {
  const channels = isPlainObject(config.channels) ? config.channels : null;
  return Boolean(channels && isPlainObject(channels[channelId]));
}

function hasChannelAccountConfig(
  config: OpenClawConfig,
  channelId: string,
  accountId: string,
): boolean {
  const channels = isPlainObject(config.channels) ? config.channels : null;
  const channelCfg = channels && isPlainObject(channels[channelId]) ? channels[channelId] : null;
  const accounts = channelCfg && isPlainObject(channelCfg.accounts) ? channelCfg.accounts : null;
  return Boolean(accounts && isPlainObject(accounts[accountId]));
}

function hasEnabledChannelAccountActivation(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  channelId: string;
}): boolean {
  if (readChannelEnabled(params.nextConfig, params.channelId) === false) {
    return false;
  }
  const channels = isPlainObject(params.nextConfig.channels) ? params.nextConfig.channels : null;
  const channelCfg =
    channels && isPlainObject(channels[params.channelId]) ? channels[params.channelId] : null;
  const accounts = channelCfg && isPlainObject(channelCfg.accounts) ? channelCfg.accounts : null;
  if (!accounts) {
    return false;
  }
  return Object.entries(accounts).some(([accountId, accountCfg]) => {
    if (!isPlainObject(accountCfg) || accountCfg.enabled === false) {
      return false;
    }
    return (
      !hasChannelAccountConfig(params.previousConfig, params.channelId, accountId) ||
      readChannelAccountEnabled(params.previousConfig, params.channelId, accountId) === false
    );
  });
}

function hasEnabledChannelAccountDeactivation(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  channelId: string;
}): boolean {
  if (readChannelEnabled(params.previousConfig, params.channelId) === false) {
    return false;
  }
  const channels = isPlainObject(params.previousConfig.channels)
    ? params.previousConfig.channels
    : null;
  const channelCfg =
    channels && isPlainObject(channels[params.channelId]) ? channels[params.channelId] : null;
  const accounts = channelCfg && isPlainObject(channelCfg.accounts) ? channelCfg.accounts : null;
  if (!accounts) {
    return false;
  }
  const channelEnabled = readChannelEnabled(params.nextConfig, params.channelId) !== false;
  return Object.entries(accounts).some(([accountId, accountCfg]) => {
    if (!isPlainObject(accountCfg) || accountCfg.enabled === false) {
      return false;
    }
    return (
      !channelEnabled ||
      !hasChannelAccountConfig(params.nextConfig, params.channelId, accountId) ||
      readChannelAccountEnabled(params.nextConfig, params.channelId, accountId) === false
    );
  });
}

function listNoopEnabledChannelLifecycleReasons(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  changedPaths: string[];
  plan: GatewayReloadPlan;
}): string[] {
  const noopPaths = new Set(params.plan.noopPaths);
  const reasons: string[] = [];
  for (const changedPath of params.changedPaths) {
    if (!noopPaths.has(changedPath)) {
      continue;
    }
    const channelMatch = /^channels\.([^.]+)(?:\.enabled)?$/.exec(changedPath);
    const accountMatch = /^channels\.([^.]+)\.accounts\.([^.]+)(?:\.enabled)?$/.exec(changedPath);
    const accountMapMatch = /^channels\.([^.]+)\.accounts$/.exec(changedPath);
    const channelId = (channelMatch?.[1] ?? accountMatch?.[1] ?? accountMapMatch?.[1])
      ?.trim()
      .toLowerCase();
    if (!channelId) {
      continue;
    }
    if (accountMapMatch) {
      if (
        hasEnabledChannelAccountActivation({
          previousConfig: params.previousConfig,
          nextConfig: params.nextConfig,
          channelId,
        })
      ) {
        reasons.push(`${changedPath}: enabled channel account activation requires gateway restart`);
      }
      if (
        hasEnabledChannelAccountDeactivation({
          previousConfig: params.previousConfig,
          nextConfig: params.nextConfig,
          channelId,
        })
      ) {
        reasons.push(
          `${changedPath}: enabled channel account deactivation requires gateway restart`,
        );
      }
      continue;
    }
    if (accountMatch) {
      const accountId = accountMatch[2]?.trim();
      if (!accountId) {
        continue;
      }
      const channelEnabled = readChannelEnabled(params.nextConfig, channelId) !== false;
      const hadAccountConfig = hasChannelAccountConfig(params.previousConfig, channelId, accountId);
      const wasEnabled =
        hadAccountConfig &&
        readChannelAccountEnabled(params.previousConfig, channelId, accountId) !== false;
      const isEnabled =
        channelEnabled &&
        hasChannelAccountConfig(params.nextConfig, channelId, accountId) &&
        readChannelAccountEnabled(params.nextConfig, channelId, accountId) !== false;
      if (!wasEnabled && isEnabled) {
        reasons.push(`${changedPath}: enabled channel account activation requires gateway restart`);
      }
      if (wasEnabled && !isEnabled) {
        reasons.push(
          `${changedPath}: enabled channel account deactivation requires gateway restart`,
        );
      }
      continue;
    }
    const hadChannelConfig = hasChannelConfig(params.previousConfig, channelId);
    const wasEnabled =
      hadChannelConfig && readChannelEnabled(params.previousConfig, channelId) !== false;
    const isEnabled =
      hasChannelConfig(params.nextConfig, channelId) &&
      readChannelEnabled(params.nextConfig, channelId) !== false;
    if (!wasEnabled && isEnabled) {
      reasons.push(`${changedPath}: enabled channel activation requires gateway restart`);
    }
    if (wasEnabled && !isEnabled) {
      reasons.push(`${changedPath}: enabled channel deactivation requires gateway restart`);
    }
  }
  return reasons;
}

export function applyNoopEnabledChannelActivationRestarts(params: {
  plan: GatewayReloadPlan;
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  changedPaths: string[];
}): GatewayReloadPlan {
  const restartReasons = listNoopEnabledChannelLifecycleReasons(params);
  if (restartReasons.length === 0) {
    return params.plan;
  }
  const restartReasonPaths = new Set(
    restartReasons.flatMap((reason) => reason.match(/^([^:]+):/)?.[1] ?? []),
  );
  return {
    ...params.plan,
    restartGateway: true,
    restartReasons: [...params.plan.restartReasons, ...restartReasons],
    noopPaths: params.plan.noopPaths.filter((path) => !restartReasonPaths.has(path)),
  };
}
