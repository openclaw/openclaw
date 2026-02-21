import { isDeepStrictEqual } from "node:util";
import chokidar from "chokidar";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import type { OpenClawConfig, ConfigFileSnapshot, GatewayReloadMode } from "../config/config.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { isPlainObject } from "../utils.js";

export type GatewayReloadSettings = {
  mode: GatewayReloadMode;
  debounceMs: number;
};

export type ChannelKind = ChannelId;

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  restartGmailWatcher: boolean;
  restartBrowserControl: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  restartChannels: Set<ChannelKind>;
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
  | "restart-browser-control"
  | "restart-cron"
  | "restart-heartbeat"
  | `restart-channel:${ChannelId}`;

const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {
  mode: "hybrid",
  debounceMs: 300,
};
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;

const BASE_RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
  { prefix: "hooks.gmail", kind: "hot", actions: ["restart-gmail-watcher"] },
  { prefix: "hooks", kind: "hot", actions: ["reload-hooks"] },
  {
    prefix: "agents.defaults.heartbeat",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
  {
    prefix: "browser",
    kind: "hot",
    actions: ["restart-browser-control"],
  },
];

const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { prefix: "meta", kind: "none" },
  { prefix: "identity", kind: "none" },
  { prefix: "wizard", kind: "none" },
  { prefix: "logging", kind: "none" },
  { prefix: "models", kind: "none" },
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
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => [
    ...(plugin.reload?.configPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        prefix,
        kind: "hot",
        actions: [`restart-channel:${plugin.id}` as ReloadAction],
      }),
    ),
    ...(plugin.reload?.noopPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        prefix,
        kind: "none",
      }),
    ),
  ]);
  const rules = [...BASE_RELOAD_RULES, ...channelReloadRules, ...BASE_RELOAD_RULES_TAIL];
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

export function diffConfigPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (prev === next) {
    return [];
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prevValue, nextValue, childPrefix);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays can contain object entries (for example memory.qmd.paths/scope.rules);
    // compare structurally so identical values are not reported as changed.
    if (isDeepStrictEqual(prev, next)) {
      return [];
    }
  }
  return [prefix || "<root>"];
}

export function resolveGatewayReloadSettings(cfg: OpenClawConfig): GatewayReloadSettings {
  const rawMode = cfg.gateway?.reload?.mode;
  const mode =
    rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid"
      ? rawMode
      : DEFAULT_RELOAD_SETTINGS.mode;
  const debounceRaw = cfg.gateway?.reload?.debounceMs;
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw)
      ? Math.max(0, Math.floor(debounceRaw))
      : DEFAULT_RELOAD_SETTINGS.debounceMs;
  return { mode, debounceMs };
}

export function buildGatewayReloadPlan(changedPaths: string[]): GatewayReloadPlan {
  const plan: GatewayReloadPlan = {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
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
      case "restart-browser-control":
        plan.restartBrowserControl = true;
        break;
      case "restart-cron":
        plan.restartCron = true;
        break;
      case "restart-heartbeat":
        plan.restartHeartbeat = true;
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

export type GatewayConfigReloader = {
  stop: () => Promise<void>;
};

export function startGatewayConfigReloader(opts: {
  initialConfig: OpenClawConfig;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  onHotReload: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  onRestart: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath: string;
}): GatewayConfigReloader {
  let currentConfig = opts.initialConfig;
  let settings = resolveGatewayReloadSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let restartQueued = false;
  let missingConfigRetries = 0;

  const scheduleAfter = (wait: number) => {
    if (stopped) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void runReload();
    }, wait);
  };
  const schedule = () => {
    scheduleAfter(settings.debounceMs);
  };
  const queueRestart = (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
    if (restartQueued) {
      return;
    }
    restartQueued = true;
    opts.onRestart(plan, nextConfig);
  };

  const handleMissingSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.exists) {
      missingConfigRetries = 0;
      return false;
    }
    if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
      missingConfigRetries += 1;
      opts.log.info(
        `config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`,
      );
      scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
      return true;
    }
    opts.log.warn("config reload skipped (config file not found)");
    return true;
  };

  const handleInvalidSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.valid) {
      return false;
    }
    const issues = snapshot.issues.map((issue) => `${issue.path}: ${issue.message}`).join(", ");
    opts.log.warn(`config reload skipped (invalid config): ${issues}`);
    return true;
  };

  const applySnapshot = async (nextConfig: OpenClawConfig) => {
    const changedPaths = diffConfigPaths(currentConfig, nextConfig);
    currentConfig = nextConfig;
    settings = resolveGatewayReloadSettings(nextConfig);
    if (changedPaths.length === 0) {
      return;
    }

    opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
    const plan = buildGatewayReloadPlan(changedPaths);
    if (settings.mode === "off") {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      return;
    }
    if (settings.mode === "restart") {
      queueRestart(plan, nextConfig);
      return;
    }
    if (plan.restartGateway) {
      if (settings.mode === "hot") {
        opts.log.warn(
          `config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(
            ", ",
          )})`,
        );
        return;
      }
      queueRestart(plan, nextConfig);
      return;
    }

    await opts.onHotReload(plan, nextConfig);
  };

  const runReload = async () => {
    if (stopped) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      const snapshot = await opts.readSnapshot();
      if (handleMissingSnapshot(snapshot)) {
        return;
      }
      if (handleInvalidSnapshot(snapshot)) {
        return;
      }
      await applySnapshot(snapshot.config);
    } catch (err) {
      opts.log.error(`config reload failed: ${String(err)}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const watcher = chokidar.watch(opts.watchPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    usePolling: Boolean(process.env.VITEST),
  });

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  let watcherClosed = false;
  watcher.on("error", (err) => {
    if (watcherClosed) {
      return;
    }
    watcherClosed = true;
    opts.log.warn(`config watcher error: ${String(err)}`);
    void watcher.close().catch(() => {});
  });

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = null;
      watcherClosed = true;
      await watcher.close().catch(() => {});
    },
  };
}
