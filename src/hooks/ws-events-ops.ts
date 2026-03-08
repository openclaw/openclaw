import { formatCliCommand } from "../cli/command-format.js";
import {
  type OpenClawConfig,
  CONFIG_PATH,
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { displayPath } from "../utils.js";
import { ensureDependency, ensureGcloudAuth, runGcloud } from "./gmail-setup-utils.js";
import { generateHookToken, mergeHookPresets, normalizeHooksPath } from "./gmail.js";
import { spawnGwsEventsSubscribe } from "./ws-events-watcher.js";
import {
  buildDefaultWsEventsHookUrl,
  buildGwsEventsSubscribeArgs,
  resolveWsEventsHookRuntimeConfig,
  type WsEventsHookOverrides,
} from "./ws-events.js";

export type WsEventsSetupOptions = {
  target: string;
  eventTypes: string[];
  project: string;
  subscription?: string;
  hookUrl?: string;
  hookToken?: string;
  pollInterval?: number;
  maxMessages?: number;
  cleanup?: boolean;
  json?: boolean;
};

export type WsEventsRunOptions = {
  target?: string;
  eventTypes?: string[];
  project?: string;
  subscription?: string;
  hookUrl?: string;
  hookToken?: string;
  pollInterval?: number;
  maxMessages?: number;
  cleanup?: boolean;
};

export async function runWsEventsSetup(opts: WsEventsSetupOptions) {
  await ensureDependency("gws", ["@googleworkspace/cli"], "npm");
  await ensureDependency("gcloud", ["--cask", "gcloud-cli"]);
  await ensureGcloudAuth();

  // Validate project exists
  await runGcloud(["projects", "describe", opts.project, "--quiet"]);

  const configSnapshot = await readConfigFileSnapshot();
  if (!configSnapshot.valid) {
    throw new Error(`Config invalid: ${CONFIG_PATH}`);
  }

  const baseConfig = configSnapshot.config;
  const hooksPath = normalizeHooksPath(baseConfig.hooks?.path);
  const hookToken = opts.hookToken ?? baseConfig.hooks?.token ?? generateHookToken();
  const hookUrl =
    opts.hookUrl ??
    baseConfig.hooks?.workspaceEvents?.hookUrl ??
    buildDefaultWsEventsHookUrl(hooksPath, resolveGatewayPort(baseConfig));

  const nextConfig: OpenClawConfig = {
    ...baseConfig,
    hooks: {
      ...baseConfig.hooks,
      enabled: true,
      path: hooksPath,
      token: hookToken,
      presets: mergeHookPresets(baseConfig.hooks?.presets, "workspace-events"),
      workspaceEvents: {
        ...baseConfig.hooks?.workspaceEvents,
        project: opts.project,
        target: opts.target,
        eventTypes: opts.eventTypes,
        ...(opts.subscription ? { subscription: opts.subscription } : {}),
        hookUrl,
        ...(opts.pollInterval !== undefined ? { pollInterval: opts.pollInterval } : {}),
        ...(opts.maxMessages !== undefined ? { maxMessages: opts.maxMessages } : {}),
        ...(opts.cleanup !== undefined ? { cleanup: opts.cleanup } : {}),
      },
    },
  };

  const validated = validateConfigObjectWithPlugins(nextConfig);
  if (!validated.ok) {
    throw new Error(`Config validation failed: ${validated.issues[0]?.message ?? "invalid"}`);
  }
  await writeConfigFile(validated.config);

  const summary: Record<string, unknown> = {
    project: opts.project,
    target: opts.target,
    eventTypes: opts.eventTypes,
    hookUrl,
    hookToken,
  };
  if (opts.subscription) {
    summary.subscription = opts.subscription;
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(summary, null, 2));
    return;
  }

  defaultRuntime.log("Workspace events hooks configured:");
  defaultRuntime.log(`- project: ${opts.project}`);
  defaultRuntime.log(`- target: ${opts.target}`);
  defaultRuntime.log(`- event types: ${opts.eventTypes.join(", ")}`);
  defaultRuntime.log(`- hook url: ${hookUrl}`);
  defaultRuntime.log(`- config: ${displayPath(CONFIG_PATH)}`);
  defaultRuntime.log(`Next: ${formatCliCommand("openclaw webhooks events run")}`);
}

export async function runWsEventsService(opts: WsEventsRunOptions) {
  await ensureDependency("gws", ["@googleworkspace/cli"], "npm");

  const config = loadConfig();
  const overrides: WsEventsHookOverrides = {
    project: opts.project,
    target: opts.target,
    eventTypes: opts.eventTypes,
    subscription: opts.subscription,
    hookToken: opts.hookToken,
    hookUrl: opts.hookUrl,
    pollInterval: opts.pollInterval,
    maxMessages: opts.maxMessages,
    cleanup: opts.cleanup,
  };

  const resolved = resolveWsEventsHookRuntimeConfig(config, overrides);
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }

  const runtimeConfig = resolved.value;
  const args = buildGwsEventsSubscribeArgs(runtimeConfig);
  defaultRuntime.log(`Starting gws ${args.join(" ")}`);

  let shuttingDown = false;
  let child = spawnGwsEventsSubscribe(runtimeConfig);

  const detachSignals = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    detachSignals();
    child.kill("SIGTERM");
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  child.on("exit", () => {
    if (shuttingDown) {
      detachSignals();
      return;
    }
    defaultRuntime.log("gws events +subscribe exited; restarting in 2s");
    setTimeout(() => {
      if (shuttingDown) {
        return;
      }
      child = spawnGwsEventsSubscribe(runtimeConfig);
    }, 2000);
  });
}
