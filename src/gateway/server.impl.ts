import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createDefaultDeps } from "../cli/deps.js";
import {
  CONFIG_PATH,
  type OpenClawConfig,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import {
  ensureControlUiAssetsBuilt,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { logAcceptedEnvOption } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startHeartbeatRunner } from "../infra/heartbeat-runner.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { ReplyChainEnforcer } from "../infra/reply-chain-enforcer.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
// -- Watchdog Imports --
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { callGateway } from "./call.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import type { ControlUiRootState } from "./control-ui.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { NodeRegistry } from "./node-registry.js";
import type { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { createChannelManager } from "./server-channels.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createGatewayCloseHandler } from "./server-close.js";
import { buildGatewayCronService } from "./server-cron.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { safeParseJson } from "./server-methods/nodes.helpers.js";
import { createSecretsHandlers } from "./server-methods/secrets.js";
import { hasConnectedMobileNode } from "./server-mobile-nodes.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { loadGatewayPlugins } from "./server-plugins.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import { logGatewayStartup } from "./server-startup-log.js";
import { startGatewaySidecars } from "./server-startup.js";
import { startGatewayTailscaleExposure } from "./server-tailscale.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { attachGatewayWsHandlers } from "./server-ws-runtime.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import { ensureGatewayStartupAuth } from "./startup-auth.js";

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureOpenClawCliOnPath();

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
const logBrowser = log.child("browser");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  const rateLimiter = rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : undefined;
  // Browser-origin WS auth attempts always use loopback-non-exempt throttling.
  const browserRateLimiter = createAuthRateLimiter({
    ...rateLimitConfig,
    exemptLoopback: false,
  });
  return { rateLimiter, browserRateLimiter };
}

export type GatewayServer = {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
  bind?: import("../config/config.js").GatewayBindMode;
  host?: string;
  controlUiEnabled?: boolean;
  openAiChatCompletionsEnabled?: boolean;
  openResponsesEnabled?: boolean;
  auth?: import("../config/config.js").GatewayAuthConfig;
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  allowCanvasHostInTests?: boolean;
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
};

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  const minimalTestGateway =
    process.env.VITEST === "1" && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";

  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });

  let configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      throw new Error(
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacyConfig(configSnapshot.parsed);
    if (!migrated) {
      throw new Error(
        `Legacy config entries detected but auto-migration failed. Run "${formatCliCommand("openclaw doctor")}" to migrate.`,
      );
    }
    await writeConfigFile(migrated);
    if (changes.length > 0) {
      log.info(
        `gateway: migrated legacy config entries:\n${changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    }
  }

  configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.exists && !configSnapshot.valid) {
    const issues =
      configSnapshot.issues.length > 0
        ? configSnapshot.issues
            .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
            .join("\n")
        : "Unknown validation issue.";
    throw new Error(
      `Invalid config at ${configSnapshot.path}.\n${issues}\nRun "${formatCliCommand("openclaw doctor")}" to repair, then retry.`,
    );
  }

  const autoEnable = applyPluginAutoEnable({ config: configSnapshot.config, env: process.env });
  if (autoEnable.changes.length > 0) {
    try {
      await writeConfigFile(autoEnable.config);
      log.info(
        `gateway: auto-enabled plugins:\n${autoEnable.changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    } catch (err) {
      log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
    }
  }

  let secretsDegraded = false;
  const emitSecretsStateEvent = (
    code: "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED",
    message: string,
    cfg: OpenClawConfig,
  ) => {
    enqueueSystemEvent(`[${code}] ${message}`, {
      sessionKey: resolveMainSessionKey(cfg),
      contextKey: code,
    });
  };
  let secretsActivationTail: Promise<void> = Promise.resolve();
  const runWithSecretsActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = secretsActivationTail.then(operation, operation);
    secretsActivationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };
  const activateRuntimeSecrets = async (
    config: OpenClawConfig,
    params: { reason: "startup" | "reload" | "restart-check"; activate: boolean },
  ) =>
    await runWithSecretsActivationLock(async () => {
      try {
        const prepared = await prepareSecretsRuntimeSnapshot({ config });
        if (params.activate) {
          activateSecretsRuntimeSnapshot(prepared);
        }
        for (const warning of prepared.warnings) {
          logSecrets.warn(`[${warning.code}] ${warning.message}`);
        }
        if (secretsDegraded) {
          const recoveredMessage =
            "Secret resolution recovered; runtime remained on last-known-good during the outage.";
          logSecrets.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
          emitSecretsStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
        }
        secretsDegraded = false;
        return prepared;
      } catch (err) {
        const details = String(err);
        if (!secretsDegraded) {
          logSecrets.error(`[SECRETS_RELOADER_DEGRADED] ${details}`);
          if (params.reason !== "startup") {
            emitSecretsStateEvent(
              "SECRETS_RELOADER_DEGRADED",
              `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`,
              config,
            );
          }
        } else {
          logSecrets.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
        }
        secretsDegraded = true;
        if (params.reason === "startup") {
          throw new Error(`Startup failed: required secrets are unavailable. ${details}`, {
            cause: err,
          });
        }
        throw err;
      }
    });

  // Fail fast before startup if required refs are unresolved.
  let cfgAtStart: OpenClawConfig;
  {
    const freshSnapshot = await readConfigFileSnapshot();
    if (!freshSnapshot.valid) {
      const issues =
        freshSnapshot.issues.length > 0
          ? freshSnapshot.issues
              .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
              .join("\n")
          : "Unknown validation issue.";
      throw new Error(`Invalid config at ${freshSnapshot.path}.\n${issues}`);
    }
    await activateRuntimeSecrets(freshSnapshot.config, {
      reason: "startup",
      activate: false,
    });
  }

  cfgAtStart = loadConfig();
  const authBootstrap = await ensureGatewayStartupAuth({
    cfg: cfgAtStart,
    env: process.env,
    authOverride: opts.auth,
    tailscaleOverride: opts.tailscale,
    persist: true,
  });
  cfgAtStart = authBootstrap.cfg;
  if (authBootstrap.generatedToken) {
    if (authBootstrap.persistedGeneratedToken) {
      log.info(
        "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
      );
    } else {
      log.warn(
        "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
      );
    }
  }
  cfgAtStart = (
    await activateRuntimeSecrets(cfgAtStart, {
      reason: "startup",
      activate: true,
    })
  ).config;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: cfgAtStart.commands?.restart === true });
  setPreRestartDeferralCheck(
    () => getTotalQueueSize() + getTotalPendingReplies() + getActiveEmbeddedRunCount(),
  );
  initSubagentRegistry();
  const defaultAgentId = resolveDefaultAgentId(cfgAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(cfgAtStart, defaultAgentId);
  const baseMethods = listGatewayMethods();
  const { pluginRegistry, gatewayMethods: baseGatewayMethods } = loadGatewayPlugins({
    cfg: cfgAtStart,
    workspaceDir: defaultWorkspaceDir,
    log,
    coreGatewayHandlers,
    baseMethods,
  });
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as Record<ChannelId, RuntimeEnv>;
  const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
  const gatewayMethods = Array.from(new Set([...baseGatewayMethods, ...channelMethods]));
  let pluginServices: PluginServicesHandle | null = null;
  const runtimeConfig = await resolveGatewayRuntimeConfig({
    cfg: cfgAtStart,
    port,
    bind: opts.bind,
    host: opts.host,
    controlUiEnabled: opts.controlUiEnabled,
    openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
    openResponsesEnabled: opts.openResponsesEnabled,
    auth: opts.auth,
    tailscale: opts.tailscale,
  });
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot: controlUiRootOverride,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  let hooksConfig = runtimeConfig.hooksConfig;
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;

  // Create auth rate limiters used by connect/auth flows.
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } =
    createGatewayAuthRateLimiters(rateLimitConfig);

  let controlUiRootState: ControlUiRootState | undefined;
  if (controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(controlUiRootOverride);
    const resolvedOverridePath = path.resolve(controlUiRootOverride);
    controlUiRootState = resolvedOverride
      ? { kind: "resolved", path: resolvedOverride }
      : { kind: "invalid", path: resolvedOverridePath };
    if (!resolvedOverride) {
      log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
    }
  } else if (controlUiEnabled) {
    let resolvedRoot = resolveControlUiRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
    if (!resolvedRoot) {
      const ensureResult = await ensureControlUiAssetsBuilt(gatewayRuntime);
      if (!ensureResult.ok && ensureResult.message) {
        log.warn(`gateway: ${ensureResult.message}`);
      }
      resolvedRoot = resolveControlUiRootSync({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      });
    }
    controlUiRootState = resolvedRoot
      ? { kind: "resolved", path: resolvedRoot }
      : { kind: "missing" };
  }

  const wizardRunner = opts.wizardRunner ?? runOnboardingWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  const deps = createDefaultDeps();
  let canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls"));
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  } = await createGatewayRuntimeState({
    cfg: cfgAtStart,
    bindHost,
    port,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot: controlUiRootState,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    resolvedAuth,
    gatewayTls,
    hooksConfig: () => hooksConfig,
    pluginRegistry,
    deps,
    canvasRuntime,
    canvasHostEnabled,
    allowCanvasHostInTests: opts.allowCanvasHostInTests,
    logCanvas,
    log,
    logHooks,
    logPlugins,
  });
  let bonjourStop: (() => Promise<void>) | null = null;
  const nodeRegistry = new NodeRegistry();
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();
  const nodeSendEvent = (opts: { nodeId: string; event: string; payloadJSON?: string | null }) => {
    const payload = safeParseJson(opts.payloadJSON ?? null);
    nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
  };
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const nodeSubscribe = nodeSubscriptions.subscribe;
  const nodeUnsubscribe = nodeSubscriptions.unsubscribe;
  const nodeUnsubscribeAll = nodeSubscriptions.unsubscribeAll;
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
  };
  const hasMobileNodeConnected = () => hasConnectedMobileNode(nodeRegistry);
  applyGatewayLaneConcurrency(cfgAtStart);

  let cronState = buildGatewayCronService({
    cfg: cfgAtStart,
    deps,
    broadcast,
  });
  let { cron, storePath: cronStorePath } = cronState;

  const channelManager = createChannelManager({
    loadConfig,
    channelLogs,
    channelRuntimeEnvs,
  });
  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;

  const machineDisplayName = await getMachineDisplayName();
  const discovery = await startGatewayDiscovery({
    machineDisplayName,
    port,
    gatewayTls: gatewayTls.enabled
      ? { enabled: true, fingerprintSha256: gatewayTls.fingerprintSha256 }
      : undefined,
    wideAreaDiscoveryEnabled: cfgAtStart.discovery?.wideArea?.enabled === true,
    wideAreaDiscoveryDomain: cfgAtStart.discovery?.wideArea?.domain,
    tailscaleMode,
    mdnsMode: cfgAtStart.discovery?.mdns?.mode,
    logDiscovery,
  });
  bonjourStop = discovery.bonjourStop;

  setSkillsRemoteRegistry(nodeRegistry);
  void primeRemoteSkillsCache();
  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const skillsRefreshDelayMs = 30_000;
  const skillsChangeUnsub = registerSkillsChangeListener((event) => {
    if (event.reason === "remote-node") {
      return;
    }
    if (skillsRefreshTimer) {
      clearTimeout(skillsRefreshTimer);
    }
    skillsRefreshTimer = setTimeout(() => {
      skillsRefreshTimer = null;
      const latest = loadConfig();
      void refreshRemoteBinsForConnectedNodes(latest);
    }, skillsRefreshDelayMs);
  });

  const { tickInterval, healthInterval, dedupeCleanup } = startGatewayMaintenanceTimers({
    broadcast,
    nodeSendToAllSubscribed,
    getPresenceVersion,
    getHealthVersion,
    refreshGatewayHealthSnapshot,
    logHealth,
    dedupe,
    chatAbortControllers,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    removeChatRun,
    agentRunSeq,
    nodeSendToSession,
  });

  // -- Watchdog Initialization (Start) --
  // Initialize Reply Chain Enforcer
  const replyEnforcer = new ReplyChainEnforcer(
    {
      enabled:
        cfgAtStart.gateway?.watchdog?.enabled !== false && cfgAtStart.cron?.enabled !== false,
      timeoutMs: cfgAtStart.gateway?.watchdog?.timeoutMs ?? 30000,
      prompt: `[System] Reply chain broken (stall detected). Resume any promised assignments, or respond with ${SILENT_REPLY_TOKEN} if you need a reply from the user.`,
    },
    {
      nowMs: () => Date.now(),
      injectSystemMessage: async (opts) => {
        try {
          await callGateway({
            method: "agent",
            params: {
              message: opts.message,
              sessionKey: opts.sessionKey,
              deliver: false,
              idempotencyKey: `watchdog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              inputProvenance: {
                kind: "internal_system",
                sourceChannel: "watchdog",
              },
            },
            timeoutMs: 10_000,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`watchdog: failed to inject system message: ${msg}`, {
            sessionKey: opts.sessionKey,
            reason: opts.reason,
            error: msg,
          });
        }
      },
    },
  );
  // Agent messages are handled via onChatFinal/onChatDelta callbacks in createAgentEventHandler.
  // No transcript file watcher needed — avoids races with heartbeat transcript pruning.

  // Watchdog handler MUST be registered BEFORE createAgentEventHandler,
  // because the latter calls registry.shift() which removes the run entry.
  const agentUnsub = onAgentEvent(
    createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun,
      clearAgentRunContext,
      toolEventRecipients,
      onChatFinal: ({ sessionKey, text }) => {
        replyEnforcer.onChatFinal(sessionKey, text);
      },
      onChatDelta: ({ sessionKey }) => {
        replyEnforcer.onChatDelta(sessionKey);
      },
    }),
  );

  // Watchdog: lifecycle error keeps the session armed (agent crashed mid-work).
  const stallAgentErrorUnsub = onAgentEvent((evt) => {
    if (evt.stream === "lifecycle" && evt.data?.phase === "error") {
      const sessionKey = resolveSessionKeyForRun(evt.runId);
      if (sessionKey) {
        replyEnforcer.onAgentLifecycle({ sessionKey, phase: "error" });
      }
    }
  });
  // -- Watchdog Initialization (End) --

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  let heartbeatRunner = startHeartbeatRunner({ cfg: cfgAtStart });

  const healthCheckMinutes = cfgAtStart.gateway?.channelHealthCheckMinutes;
  const healthCheckDisabled = healthCheckMinutes === 0;
  const channelHealthMonitor = healthCheckDisabled
    ? null
    : startChannelHealthMonitor({
        channelManager,
        checkIntervalMs: (healthCheckMinutes ?? 5) * 60_000,
      });

  void cron.start().catch((err) => logCron.error(`failed to start: ${String(err)}`));

  const execApprovalManager = new ExecApprovalManager();
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
    forwarder: execApprovalForwarder,
  });
  const secretsHandlers = createSecretsHandlers({
    reloadSecrets: async () => {
      const active = getActiveSecretsRuntimeSnapshot();
      if (!active) {
        throw new Error("Secrets runtime snapshot is not active.");
      }
      const prepared = await activateRuntimeSecrets(active.sourceConfig, {
        reason: "reload",
        activate: true,
      });
      return { warningCount: prepared.warnings.length };
    },
  });

  const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

  attachGatewayWsHandlers({
    wss,
    clients,
    port,
    gatewayHost: bindHost ?? undefined,
    canvasHostEnabled: Boolean(canvasHost),
    canvasHostServerPort,
    resolvedAuth,
    rateLimiter: authRateLimiter,
    browserRateLimiter: browserAuthRateLimiter,
    gatewayMethods,
    events: GATEWAY_EVENTS,
    logGateway: log,
    logHealth,
    logWsControl,
    extraHandlers: {
      ...pluginRegistry.gatewayHandlers,
      ...execApprovalHandlers,
      ...secretsHandlers,
    },
    broadcast,
    context: {
      deps,
      cron,
      cronStorePath,
      loadGatewayModelCatalog,
      getHealthCache,
      refreshHealthSnapshot: refreshGatewayHealthSnapshot,
      logHealth,
      logGateway: log,
      incrementPresenceVersion,
      getHealthVersion,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeSendToAllSubscribed,
      nodeSubscribe,
      nodeUnsubscribe,
      nodeUnsubscribeAll,
      hasConnectedMobileNode: hasMobileNodeConnected,
      hasExecApprovalClients: () => {
        for (const gatewayClient of clients) {
          const scopes = Array.isArray(gatewayClient.connect.scopes)
            ? gatewayClient.connect.scopes
            : [];
          if (scopes.includes("operator.admin") || scopes.includes("operator.approvals")) {
            return true;
          }
        }
        return false;
      },
      nodeRegistry,
      agentRunSeq,
      chatAbortControllers,
      chatAbortedRuns: chatRunState.abortedRuns,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      addChatRun,
      removeChatRun,
      registerToolEventRecipient: toolEventRecipients.add,
      dedupe,
      wizardSessions,
      findRunningWizard,
      purgeWizardSession,
      getRuntimeSnapshot,
      startChannel,
      stopChannel,
      markChannelLoggedOut,
      wizardRunner,
      broadcastVoiceWakeChanged,
    },
  });
  logGatewayStartup({
    cfg: cfgAtStart,
    bindHost,
    bindHosts: httpBindHosts,
    port,
    tlsEnabled: gatewayTls.enabled,
    log,
    isNixMode,
  });
  const stopGatewayUpdateCheck = minimalTestGateway
    ? () => {}
    : scheduleGatewayUpdateCheck({
        cfg: cfgAtStart,
        log,
        isNixMode,
        onUpdateAvailableChange: (updateAvailable) => {
          const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
          broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
        },
      });
  const tailscaleCleanup = minimalTestGateway
    ? null
    : await startGatewayTailscaleExposure({
        tailscaleMode,
        resetOnExit: tailscaleConfig.resetOnExit,
        port,
        controlUiBasePath,
        logTailscale,
      });

  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  ({ browserControl, pluginServices } = await startGatewaySidecars({
    cfg: cfgAtStart,
    pluginRegistry,
    defaultWorkspaceDir,
    deps,
    startChannels,
    log,
    logHooks,
    logChannels,
    logBrowser,
  }));

  const configReloader = minimalTestGateway
    ? { stop: async () => {} }
    : (() => {
        const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
          deps,
          broadcast,
          getState: () => ({
            hooksConfig,
            heartbeatRunner,
            cronState,
            browserControl,
          }),
          setState: (nextState) => {
            hooksConfig = nextState.hooksConfig;
            heartbeatRunner = nextState.heartbeatRunner;
            cronState = nextState.cronState;
            cron = cronState.cron;
            cronStorePath = cronState.storePath;
            browserControl = nextState.browserControl;

            // Update Watchdog config live
            const latestCfg = loadConfig();
            replyEnforcer.updateConfig({
              enabled:
                latestCfg.gateway?.watchdog?.enabled !== false && latestCfg.cron?.enabled !== false,
              timeoutMs: latestCfg.gateway?.watchdog?.timeoutMs ?? 30000,
              prompt: `[System] Reply chain broken (stall detected). Resume any promised assignments, or respond with ${SILENT_REPLY_TOKEN} if you need a reply from the user.`,
            });
          },
          startChannel,
          stopChannel,
          logHooks,
          logBrowser,
          logChannels,
          logCron,
          logReload,
        });

        return startGatewayConfigReloader({
          initialConfig: cfgAtStart,
          readSnapshot: readConfigFileSnapshot,
          onHotReload: async (plan, nextConfig) => {
            const previousSnapshot = getActiveSecretsRuntimeSnapshot();
            const prepared = await activateRuntimeSecrets(nextConfig, {
              reason: "reload",
              activate: true,
            });
            try {
              await applyHotReload(plan, prepared.config);
            } catch (err) {
              if (previousSnapshot) {
                activateSecretsRuntimeSnapshot(previousSnapshot);
              } else {
                clearSecretsRuntimeSnapshot();
              }
              throw err;
            }
          },
          onRestart: async (plan, nextConfig) => {
            await activateRuntimeSecrets(nextConfig, { reason: "restart-check", activate: false });
            requestGatewayRestart(plan, nextConfig);
          },
          log: {
            info: (msg) => logReload.info(msg),
            warn: (msg) => logReload.warn(msg),
            error: (msg) => logReload.error(msg),
          },
          watchPath: CONFIG_PATH,
        });
      })();

  const close = createGatewayCloseHandler({
    bonjourStop,
    tailscaleCleanup,
    canvasHost,
    canvasHostServer,
    stopChannel,
    pluginServices,
    cron,
    heartbeatRunner,
    updateCheckStop: stopGatewayUpdateCheck,
    nodePresenceTimers,
    broadcast,
    tickInterval,
    healthInterval,
    dedupeCleanup,
    agentUnsub,
    heartbeatUnsub,
    chatRunState,
    clients,
    configReloader,
    browserControl,
    wss,
    httpServer,
    httpServers,
  });

  return {
    close: async (opts) => {
      if (diagnosticsEnabled) {
        stopDiagnosticHeartbeat();
      }
      if (skillsRefreshTimer) {
        clearTimeout(skillsRefreshTimer);
        skillsRefreshTimer = null;
      }
      skillsChangeUnsub();
      stallAgentErrorUnsub();
      replyEnforcer.stopAll();
      authRateLimiter?.dispose();
      browserAuthRateLimiter.dispose();
      channelHealthMonitor?.stop();
      clearSecretsRuntimeSnapshot();
      await close(opts);
    },
  };
}
