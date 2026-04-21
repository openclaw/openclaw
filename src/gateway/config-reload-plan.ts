import { isDeepStrictEqual } from "node:util";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

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
  restartChannels: Set<ChannelKind>;
  noopPaths: string[];
};

const INSTALL_RECORD_METADATA_FIELDS = ["resolvedAt", "installedAt"] as const;
type InstallRecordMetadataField = (typeof INSTALL_RECORD_METADATA_FIELDS)[number];
const INSTALL_RECORD_METADATA_FIELD_SET = new Set<string>(INSTALL_RECORD_METADATA_FIELDS);

/**
 * Plugin install records (`plugins.installs.<id>.*`) refresh `resolvedAt` / `installedAt` during
 * npm installs and runtime self-updates without changing `plugins.entries` or other effective
 * gateway config. Only suppress leaf-field updates when the same install record exists on both
 * sides and every changed field is metadata, so dotted plugin ids like `foo.resolvedAt` do not
 * cause whole-record additions/removals to be misclassified as metadata-only changes (#49474).
 */
export function listPluginInstallRecordMetadataOnlyPaths(params: {
  prevInstalls?: Record<string, PluginInstallRecord>;
  nextInstalls?: Record<string, PluginInstallRecord>;
}): Set<string> {
  const prevInstalls = params.prevInstalls ?? {};
  const nextInstalls = params.nextInstalls ?? {};
  const suppressedPaths = new Set<string>();
  const pluginIds = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);

  for (const pluginId of pluginIds) {
    const prevRecord = prevInstalls[pluginId];
    const nextRecord = nextInstalls[pluginId];
    if (!prevRecord || !nextRecord) {
      continue;
    }

    const changedFields: InstallRecordMetadataField[] = [];
    const recordKeys = new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)]);
    let hasNonMetadataChange = false;

    for (const key of recordKeys) {
      const typedKey = key as keyof PluginInstallRecord;
      if (isDeepStrictEqual(prevRecord[typedKey], nextRecord[typedKey])) {
        continue;
      }
      if (!INSTALL_RECORD_METADATA_FIELD_SET.has(key)) {
        hasNonMetadataChange = true;
        break;
      }
      changedFields.push(key as InstallRecordMetadataField);
    }

    if (hasNonMetadataChange || changedFields.length === 0) {
      continue;
    }

    for (const field of changedFields) {
      suppressedPaths.add(`plugins.installs.${pluginId}.${field}`);
    }
  }

  return suppressedPaths;
}

/**
 * Paths emitted as a single prefix when an install record is added or removed
 * (`diffConfigPaths` returns `plugins.installs.<id>` when one side is missing and the other is an object).
 * These strings collide with metadata leaf paths like `plugins.installs.foo.resolvedAt` when the plugin id
 * is literally `foo.resolvedAt` (whole record) vs plugin `foo` field `resolvedAt` (metadata).
 */
export function listPluginInstallRecordWholeRecordPaths(params: {
  prevInstalls?: Record<string, PluginInstallRecord>;
  nextInstalls?: Record<string, PluginInstallRecord>;
}): Set<string> {
  const prevInstalls = params.prevInstalls ?? {};
  const nextInstalls = params.nextInstalls ?? {};
  const paths = new Set<string>();
  const pluginIds = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);

  for (const pluginId of pluginIds) {
    const prevRecord = prevInstalls[pluginId];
    const nextRecord = nextInstalls[pluginId];
    const hasPrev = prevRecord !== undefined;
    const hasNext = nextRecord !== undefined;
    if (hasPrev !== hasNext) {
      paths.add(`plugins.installs.${pluginId}`);
    }
  }

  return paths;
}

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
  | `restart-channel:${ChannelId}`;

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
  // Stuck-session warning threshold is read by the diagnostics heartbeat loop.
  { prefix: "diagnostics.stuckSessionWarnMs", kind: "none" },
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
  { prefix: "plugins", kind: "restart" },
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
  { prefix: "canvasHost", kind: "restart" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function listReloadRules(): ReloadRule[] {
  const registry = getActivePluginRegistry();
  if (registry !== cachedRegistry) {
    cachedReloadRules = null;
    cachedRegistry = registry;
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

export function buildGatewayReloadPlan(changedPaths: string[]): GatewayReloadPlan {
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
    restartChannels: new Set(),
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
      default:
        break;
    }
  };

  for (const path of changedPaths) {
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
