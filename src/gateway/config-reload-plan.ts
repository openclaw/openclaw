import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
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
  // Stuck-session thresholds are read by the diagnostics heartbeat loop.
  { prefix: "diagnostics.stuckSessionWarnMs", kind: "none" },
  { prefix: "diagnostics.stuckSessionAbortMs", kind: "none" },
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
  { prefix: "installedPluginIndex.installRecords", kind: "restart" },
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

function isInstalledPluginIndexTimestampPath(path: string): boolean {
  return /^installedPluginIndex\.installRecords\..+\.(installedAt|resolvedAt)$/.test(path);
}

function getInstalledPluginIndexRecords(state: unknown): Record<string, unknown> {
  if (!isPlainObject(state)) {
    return {};
  }
  const pluginIndex = state.installedPluginIndex;
  if (!isPlainObject(pluginIndex)) {
    return {};
  }
  const records = pluginIndex.installRecords;
  return isPlainObject(records) ? records : {};
}

export function listInstalledPluginIndexTimestampMetadataPaths(
  prevState: unknown,
  nextState: unknown,
): string[] {
  const prevInstalls = getInstalledPluginIndexRecords(prevState);
  const nextInstalls = getInstalledPluginIndexRecords(nextState);
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
        paths.push(`installedPluginIndex.installRecords.${id}.${key}`);
      }
    }
  }

  return paths;
}

export function listInstalledPluginIndexWholeRecordPaths(
  prevState: unknown,
  nextState: unknown,
): string[] {
  const prevInstalls = getInstalledPluginIndexRecords(prevState);
  const nextInstalls = getInstalledPluginIndexRecords(nextState);
  const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
  const paths: string[] = [];

  for (const id of ids) {
    const prevRecord = prevInstalls[id];
    const nextRecord = nextInstalls[id];
    if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
      paths.push(`installedPluginIndex.installRecords.${id}`);
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
      (noopPaths.size > 0 ? noopPaths.has(path) : isInstalledPluginIndexTimestampPath(path));
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
