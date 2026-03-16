import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.js";
import {
  type OpenClawConfig,
  isNixMode,
  loadConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { logAcceptedEnvOption } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
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
import { getGlobalHookRunner, runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import type { CommandSecretAssignment } from "../secrets/command-config.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import {
  prepareSecretsRuntimeSnapshot,
  resolveCommandSecretsFromActiveRuntimeSnapshot,
} from "../secrets/runtime.js";
import { runSetupWizard } from "../wizard/setup.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { NodeRegistry } from "./node-registry.js";
import {
  createGlobalRuntimeStateContainer,
  type RuntimeStateContainer,
} from "./runtime-state-container.js";
import type { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { createChannelManager } from "./server-channels.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createGatewayCloseHandler } from "./server-close.js";
import { startGatewayRuntimeConfigReloader } from "./server-config-reloader-runtime.js";
import { resolveGatewayControlUiRootState } from "./server-control-ui-root-state.js";
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
import { loadGatewayPlugins, setFallbackGatewayContext } from "./server-plugins.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import { logGatewayStartup } from "./server-startup-log.js";
import {
  runGatewayStartupAuthBootstrap,
  runGatewayStartupConfigPreflight,
  runGatewayStartupRuntimePolicyPhase,
  runGatewayStartupSecretsPrecheck,
} from "./server-startup-preflight.js";
import { createGatewaySecretsActivationController } from "./server-startup-secrets.js";
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
import { resolveHookClientIpConfig } from "./server/hooks.js";
import { createReadinessChecker } from "./server/readiness.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import {
  ensureGatewayStartupAuth,
  mergeGatewayAuthConfig,
  mergeGatewayTailscaleConfig,
} from "./startup-auth.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureOpenClawCliOnPath();

const MAX_MEDIA_TTL_HOURS = 24 * 7;

function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
const logBrowser = log.child("browser");

let cachedChannelRuntime: ReturnType<typeof createPluginRuntime>["channel"] | null = null;

function getChannelRuntime() {
  cachedChannelRuntime ??= createPluginRuntime().channel;
  return cachedChannelRuntime;
}
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

function logGatewayAuthSurfaceDiagnostics(prepared: {
  sourceConfig: OpenClawConfig;
  warnings: Array<{ code: string; path: string; message: string }>;
}): void {
  const states = evaluateGatewayAuthSurfaceStates({
    config: prepared.sourceConfig,
    defaults: prepared.sourceConfig.secrets?.defaults,
    env: process.env,
  });
  const inactiveWarnings = new Map<string, string>();
  for (const warning of prepared.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarnings.set(warning.path, warning.message);
  }
  for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
    const state = states[path];
    if (!state.hasSecretRef) {
      continue;
    }
    const stateLabel = state.active ? "active" : "inactive";
    const inactiveDetails =
      !state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : undefined;
    const details = inactiveDetails ?? state.reason;
    logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
  }
}

function applyGatewayAuthOverridesForStartupPreflight(
  config: OpenClawConfig,
  overrides: Pick<GatewayServerOptions, "auth" | "tailscale">,
): OpenClawConfig {
  if (!overrides.auth && !overrides.tailscale) {
    return config;
  }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth),
      tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale),
    },
  };
}

export type GatewayServer = {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Runtime state container used for startup/reload/shutdown state transitions.
   * Defaults to global runtime adapters for backward compatibility.
   */
  runtimeState?: RuntimeStateContainer;
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the setup wizard runner.
   */
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
  const runtimeState = opts.runtimeState ?? createGlobalRuntimeStateContainer();
  const minimalTestGateway =
    process.env.VITEST === "1" && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";

  // Ensure all default port derivations (browser/canvas) see the actual runtime port.
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });

  let startupContext = await runGatewayStartupConfigPreflight({
    readSnapshot: readConfigFileSnapshot,
    writeConfig: writeConfigFile,
    log,
    isNixMode,
  });

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
  const { activateRuntimeSecrets } = createGatewaySecretsActivationController({
    prepareSecretsRuntimeSnapshot,
    activateRuntimeSnapshot: (snapshot) => runtimeState.secretsRuntime.activate(snapshot),
    onAuthSurfaceDiagnostics: logGatewayAuthSurfaceDiagnostics,
    log: {
      info: (message) => logSecrets.info(message),
      warn: (message) => logSecrets.warn(message),
      error: (message) => logSecrets.error(message),
    },
    emitStateEvent: emitSecretsStateEvent,
  });

  // Fail fast before startup if required refs are unresolved.
  let cfgAtStart: OpenClawConfig;
  startupContext = await runGatewayStartupSecretsPrecheck({
    context: startupContext,
    readSnapshot: readConfigFileSnapshot,
    prepareConfig: (config) =>
      applyGatewayAuthOverridesForStartupPreflight(config, {
        auth: opts.auth,
        tailscale: opts.tailscale,
      }),
    activateRuntimeSecrets: async (config) => {
      await activateRuntimeSecrets(config, {
        reason: "startup",
        activate: false,
      });
    },
  });

  startupContext = await runGatewayStartupAuthBootstrap({
    loadConfig,
    context: startupContext,
    ensureGatewayStartupAuth,
    activateRuntimeSecrets: async (config) =>
      await activateRuntimeSecrets(config, {
        reason: "startup",
        activate: true,
      }),
    log,
    authOverride: opts.auth,
    tailscaleOverride: opts.tailscale,
  });
  startupContext = await runGatewayStartupRuntimePolicyPhase({
    context: startupContext,
    isDiagnosticsEnabled,
    startDiagnosticHeartbeat,
    isRestartEnabled,
    setGatewaySigusr1RestartPolicy,
    setPreRestartDeferralCheck,
    getPendingWorkCount: () =>
      getTotalQueueSize() + getTotalPendingReplies() + getActiveEmbeddedRunCount(),
    seedControlUiAllowedOrigins: async (config) =>
      await maybeSeedControlUiAllowedOriginsAtStartup({
        // Unconditional startup migration: seed gateway.controlUi.allowedOrigins for existing
        // non-loopback installs that upgraded to v2026.2.26+ without required origins.
        config,
        writeConfig: writeConfigFile,
        log,
      }),
  });
  cfgAtStart = startupContext.config;
  const diagnosticsEnabled = startupContext.diagnosticsEnabled;

  initSubagentRegistry();
  const defaultAgentId = resolveDefaultAgentId(cfgAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(cfgAtStart, defaultAgentId);
  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  const { pluginRegistry, gatewayMethods: baseGatewayMethods } = minimalTestGateway
    ? { pluginRegistry: emptyPluginRegistry, gatewayMethods: baseMethods }
    : loadGatewayPlugins({
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
  // Persist runtime-derived startup data so later phases/tests can assert phase outputs explicitly.
  startupContext = { ...startupContext, runtimeConfig };
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
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
  let hookClientIpConfig = resolveHookClientIpConfig(cfgAtStart);
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;

  // Create auth rate limiters used by connect/auth flows.
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } =
    createGatewayAuthRateLimiters(rateLimitConfig);

  const controlUiRootState = await resolveGatewayControlUiRootState({
    controlUiEnabled,
    controlUiRootOverride,
    gatewayRuntime,
    log,
    runtimePathContext: {
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    },
  });
  // Keep resolved control-ui startup state in the shared context for deterministic phase tracking.
  startupContext = { ...startupContext, controlUiRootState };

  const wizardRunner = opts.wizardRunner ?? runSetupWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  const deps = createDefaultDeps();
  let canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls"));
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const serverStartedAt = Date.now();
  const channelManager = createChannelManager({
    loadConfig,
    channelLogs,
    channelRuntimeEnvs,
    resolveChannelRuntime: getChannelRuntime,
  });
  const getReadiness = createReadinessChecker({
    channelManager,
    startedAt: serverStartedAt,
  });
  const {
    canvasHost,
    releasePluginRouteRegistry,
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
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    resolvedAuth,
    rateLimiter: authRateLimiter,
    gatewayTls,
    hooksConfig: () => hooksConfig,
    getHookClientIpConfig: () => hookClientIpConfig,
    pluginRegistry,
    deps,
    canvasRuntime,
    canvasHostEnabled,
    allowCanvasHostInTests: opts.allowCanvasHostInTests,
    logCanvas,
    log,
    logHooks,
    logPlugins,
    getReadiness,
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

  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;

  if (!minimalTestGateway) {
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
  }

  if (!minimalTestGateway) {
    setSkillsRemoteRegistry(nodeRegistry);
    void primeRemoteSkillsCache();
  }
  // Debounce skills-triggered node probes to avoid feedback loops and rapid-fire invokes.
  // Skills changes can happen in bursts (e.g., file watcher events), and each probe
  // takes time to complete. A 30-second delay ensures we batch changes together.
  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const skillsRefreshDelayMs = 30_000;
  const skillsChangeUnsub = minimalTestGateway
    ? () => {}
    : registerSkillsChangeListener((event) => {
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

  const noopInterval = () => setInterval(() => {}, 1 << 30);
  let tickInterval = noopInterval();
  let healthInterval = noopInterval();
  let dedupeCleanup = noopInterval();
  let mediaCleanup: ReturnType<typeof setInterval> | null = null;
  if (!minimalTestGateway) {
    ({ tickInterval, healthInterval, dedupeCleanup, mediaCleanup } = startGatewayMaintenanceTimers({
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
      ...(typeof cfgAtStart.media?.ttlHours === "number"
        ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) }
        : {}),
    }));
  }

  const agentUnsub = minimalTestGateway
    ? null
    : onAgentEvent(
        createAgentEventHandler({
          broadcast,
          broadcastToConnIds,
          nodeSendToSession,
          agentRunSeq,
          chatRunState,
          resolveSessionKeyForRun,
          clearAgentRunContext,
          toolEventRecipients,
        }),
      );

  const heartbeatUnsub = minimalTestGateway
    ? null
    : onHeartbeatEvent((evt) => {
        broadcast("heartbeat", evt, { dropIfSlow: true });
      });

  let heartbeatRunner: HeartbeatRunner = minimalTestGateway
    ? {
        stop: () => {},
        updateConfig: () => {},
      }
    : startHeartbeatRunner({ cfg: cfgAtStart });

  const healthCheckMinutes = cfgAtStart.gateway?.channelHealthCheckMinutes;
  const healthCheckDisabled = healthCheckMinutes === 0;
  const staleEventThresholdMinutes = cfgAtStart.gateway?.channelStaleEventThresholdMinutes;
  const maxRestartsPerHour = cfgAtStart.gateway?.channelMaxRestartsPerHour;
  let channelHealthMonitor = healthCheckDisabled
    ? null
    : startChannelHealthMonitor({
        channelManager,
        checkIntervalMs: (healthCheckMinutes ?? 5) * 60_000,
        ...(staleEventThresholdMinutes != null && {
          staleEventThresholdMs: staleEventThresholdMinutes * 60_000,
        }),
        ...(maxRestartsPerHour != null && { maxRestartsPerHour }),
      });

  if (!minimalTestGateway) {
    void cron.start().catch((err) => logCron.error(`failed to start: ${String(err)}`));
  }

  // Recover pending outbound deliveries from previous crash/restart.
  if (!minimalTestGateway) {
    void (async () => {
      const { recoverPendingDeliveries } = await import("../infra/outbound/delivery-queue.js");
      const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
      const logRecovery = log.child("delivery-recovery");
      await recoverPendingDeliveries({
        deliver: deliverOutboundPayloads,
        log: logRecovery,
        cfg: cfgAtStart,
      });
    })().catch((err) => log.error(`Delivery recovery failed: ${String(err)}`));
  }

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
    resolveSecrets: async ({ commandName, targetIds }) => {
      const { assignments, diagnostics, inactiveRefPaths } =
        resolveCommandSecretsFromActiveRuntimeSnapshot({
          commandName,
          targetIds: new Set(targetIds),
        });
      if (assignments.length === 0) {
        return { assignments: [] as CommandSecretAssignment[], diagnostics, inactiveRefPaths };
      }
      return { assignments, diagnostics, inactiveRefPaths };
    },
  });

  const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

  const gatewayRequestContext: import("./server-methods/types.js").GatewayRequestContext = {
    deps,
    cron,
    cronStorePath,
    execApprovalManager,
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
  };

  // Store the gateway context as a fallback for plugin subagent dispatch
  // in non-WS paths (Telegram polling, WhatsApp, etc.) where no per-request
  // scope is set via AsyncLocalStorage.
  setFallbackGatewayContext(gatewayRequestContext);

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
    context: gatewayRequestContext,
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
  if (!minimalTestGateway) {
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
  }

  // Run gateway_start plugin hook (fire-and-forget)
  if (!minimalTestGateway) {
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("gateway_start")) {
      void hookRunner.runGatewayStart({ port }, { port }).catch((err) => {
        log.warn(`gateway_start hook failed: ${String(err)}`);
      });
    }
  }

  const configReloader = minimalTestGateway
    ? { stop: async () => {} }
    : (() => {
        const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
          deps,
          broadcast,
          getState: () => ({
            hooksConfig,
            hookClientIpConfig,
            heartbeatRunner,
            cronState,
            browserControl,
            channelHealthMonitor,
          }),
          setState: (nextState) => {
            hooksConfig = nextState.hooksConfig;
            hookClientIpConfig = nextState.hookClientIpConfig;
            heartbeatRunner = nextState.heartbeatRunner;
            cronState = nextState.cronState;
            cron = cronState.cron;
            cronStorePath = cronState.storePath;
            browserControl = nextState.browserControl;
            channelHealthMonitor = nextState.channelHealthMonitor;
          },
          startChannel,
          stopChannel,
          logHooks,
          logBrowser,
          logChannels,
          logCron,
          logReload,
          createHealthMonitor: (opts: {
            checkIntervalMs: number;
            staleEventThresholdMs?: number;
            maxRestartsPerHour?: number;
          }) =>
            startChannelHealthMonitor({
              channelManager,
              checkIntervalMs: opts.checkIntervalMs,
              ...(opts.staleEventThresholdMs != null && {
                staleEventThresholdMs: opts.staleEventThresholdMs,
              }),
              ...(opts.maxRestartsPerHour != null && {
                maxRestartsPerHour: opts.maxRestartsPerHour,
              }),
            }),
        });

        return startGatewayRuntimeConfigReloader({
          initialConfig: cfgAtStart,
          readSnapshot: readConfigFileSnapshot,
          activateRuntimeSecrets,
          applyHotReload,
          requestGatewayRestart,
          secretsRuntime: runtimeState.secretsRuntime,
          log: {
            info: (msg) => logReload.info(msg),
            warn: (msg) => logReload.warn(msg),
            error: (msg) => logReload.error(msg),
          },
        });
      })();

  const close = createGatewayCloseHandler({
    bonjourStop,
    tailscaleCleanup,
    canvasHost,
    canvasHostServer,
    releasePluginRouteRegistry,
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
    mediaCleanup,
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
      // Run gateway_stop plugin hook before shutdown
      await runGlobalGatewayStopSafely({
        event: { reason: opts?.reason ?? "gateway stopping" },
        ctx: { port },
        onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
      });
      if (diagnosticsEnabled) {
        stopDiagnosticHeartbeat();
      }
      if (skillsRefreshTimer) {
        clearTimeout(skillsRefreshTimer);
        skillsRefreshTimer = null;
      }
      skillsChangeUnsub();
      authRateLimiter?.dispose();
      browserAuthRateLimiter.dispose();
      channelHealthMonitor?.stop();
      runtimeState.secretsRuntime.clear();
      await close(opts);
    },
  };
}
