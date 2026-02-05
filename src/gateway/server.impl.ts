import fs from "node:fs";
import path from "node:path";
import type { CanvasHostServer } from "../canvas-host/server.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createDefaultDeps } from "../cli/deps.js";
import {
  CONFIG_PATH,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
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
import { startHeartbeatRunner, runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { ReplyChainEnforcer } from "../infra/reply-chain-enforcer.js";
import { setGatewaySigusr1RestartPolicy } from "../infra/restart.js";
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js";
import { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
// -- Watchdog Imports --
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { NodeRegistry } from "./node-registry.js";
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
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

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

  const cfgAtStart = loadConfig();
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: cfgAtStart.commands?.restart === true });
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
    controlUiBasePath,
    controlUiRoot: controlUiRootOverride,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  let hooksConfig = runtimeConfig.hooksConfig;
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;

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
      runHeartbeatOnce: async (opts) => {
        const runtimeConfig = loadConfig();
        return await runHeartbeatOnce({
          cfg: runtimeConfig,
          reason: opts.reason,
          prompt: opts.prompt,
          sessionKey: opts.sessionKey,
        });
      },
    },
  );
  replyEnforcer.start();

  const sessionIdToKey = new Map<string, string>();
  const resolveKeyFromId = (id: string) => {
    if (sessionIdToKey.has(id)) {
      return sessionIdToKey.get(id)!;
    }

    // Resolve directly from store to get the FULL key (with agent: prefix)
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const found = Object.entries(store).find(([, entry]) => entry?.sessionId === id);
    const fullKey = found?.[0];

    if (fullKey) {
      sessionIdToKey.set(id, fullKey);
      return fullKey;
    }

    // Fallback to run-based resolution (might be stripped, but better than nothing)
    const resolved = resolveSessionKeyForRun(id);
    if (resolved) {
      // If resolveSessionKeyForRun returned a stripped key, we might be in trouble,
      // but it's a fallback.
      sessionIdToKey.set(id, resolved);
      return resolved;
    }
    return undefined;
  };

  const transcriptUnsub = onSessionTranscriptUpdate((evt) => {
    try {
      if (!fs.existsSync(evt.sessionFile)) {
        return;
      }

      const content = fs.readFileSync(evt.sessionFile, "utf-8");
      const lines = content.trim().split("\n");
      if (lines.length === 0) {
        return;
      }

      const lastLine = lines[lines.length - 1];
      const entry = JSON.parse(lastLine);

      // Extract sessionId from filename
      const filename = path.basename(evt.sessionFile);
      const sessionId = filename.replace(/\.jsonl$/, "").replace(/\.json$/, "");

      // Resolve proper SessionKey
      const sessionKey = resolveKeyFromId(sessionId) ?? sessionId;

      const msg = entry.message || {};
      const role = msg.role;
      let text = "";

      if (Array.isArray(msg.content)) {
        text = msg.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((c: any) => c.type === "text")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((c: any) => c.text)
          .join("\n");
      } else if (typeof msg.content === "string") {
        text = msg.content;
      }

      let source: "user" | "agent" | undefined;
      if (role === "user") {
        source = "user";
      } else if (role === "assistant") {
        source = "agent";
      }

      if (source && sessionKey) {
        replyEnforcer.onTranscriptUpdate({
          sessionKey,
          source,
          text,
        });
      }
    } catch (err) {
      log.warn("Failed to process transcript update", { file: evt.sessionFile, err });
    }
  });

  const stallAgentEndUnsub = onAgentEvent((evt) => {
    if (evt.stream === "lifecycle" && (evt.data?.phase === "end" || evt.data?.phase === "error")) {
      const sessionKey = resolveSessionKeyForRun(evt.runId);
      if (sessionKey) {
        const chatLink = chatRunState.registry.peek(evt.runId);
        const clientRunId = chatLink?.clientRunId ?? evt.runId;
        const text = chatRunState.buffers.get(clientRunId)?.trim();

        const isSignOff =
          !text ||
          text === SILENT_REPLY_TOKEN ||
          text === "NO_REPLY" ||
          text === "HEARTBEAT_OK" ||
          text.endsWith(SILENT_REPLY_TOKEN) ||
          text.endsWith("NO_REPLY");

        if (isSignOff) {
          replyEnforcer.onTranscriptUpdate({
            sessionKey,
            source: "agent",
            text: SILENT_REPLY_TOKEN,
          });
          replyEnforcer.onAgentLifecycle({ sessionKey, phase: evt.data.phase });
        } else if (evt.data.phase === "error") {
          replyEnforcer.onAgentLifecycle({ sessionKey, phase: "error" });
        }
      }
    }
  });

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
    }),
  );

  const stallAgentStartUnsub = onAgentEvent((evt) => {
    if (evt.stream === "lifecycle" && evt.data?.phase === "start") {
      const sessionKey = resolveSessionKeyForRun(evt.runId);
      if (sessionKey) {
        replyEnforcer.onAgentLifecycle({ sessionKey, phase: "start" });
      }
    }
  });
  // -- Watchdog Initialization (End) --

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  let heartbeatRunner = startHeartbeatRunner({ cfg: cfgAtStart });

  void cron.start().catch((err) => logCron.error(`failed to start: ${String(err)}`));

  const execApprovalManager = new ExecApprovalManager();
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
    forwarder: execApprovalForwarder,
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
    gatewayMethods,
    events: GATEWAY_EVENTS,
    logGateway: log,
    logHealth,
    logWsControl,
    extraHandlers: {
      ...pluginRegistry.gatewayHandlers,
      ...execApprovalHandlers,
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
  scheduleGatewayUpdateCheck({ cfg: cfgAtStart, log, isNixMode });
  const tailscaleCleanup = await startGatewayTailscaleExposure({
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

  const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
    deps,
    broadcast,
    getState: () => ({
      hooksConfig,
      heartbeatRunner,
      cronState,
      browserControl,
      // Pass replyEnforcer to reload handler if needed (future work)
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

  const configReloader = startGatewayConfigReloader({
    initialConfig: cfgAtStart,
    readSnapshot: readConfigFileSnapshot,
    onHotReload: applyHotReload,
    onRestart: requestGatewayRestart,
    log: {
      info: (msg) => logReload.info(msg),
      warn: (msg) => logReload.warn(msg),
      error: (msg) => logReload.error(msg),
    },
    watchPath: CONFIG_PATH,
  });

  const close = createGatewayCloseHandler({
    bonjourStop,
    tailscaleCleanup,
    canvasHost,
    canvasHostServer,
    stopChannel,
    pluginServices,
    cron,
    heartbeatRunner,
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
      transcriptUnsub();
      stallAgentEndUnsub();
      stallAgentStartUnsub();
      replyEnforcer.stop();
      await close(opts);
    },
  };
}
