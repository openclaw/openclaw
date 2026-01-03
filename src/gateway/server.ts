import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server as HttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { type WebSocket, WebSocketServer } from "ws";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../auto-reply/thinking.js";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import {
  type CanvasHostHandler,
  type CanvasHostServer,
  createCanvasHostHandler,
  startCanvasHost,
} from "../canvas-host/server.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { getHealthSnapshot, type HealthSummary } from "../commands/health.js";
import {
  CONFIG_PATH_CLAWDIS,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  STATE_DIR_CLAWDIS,
  validateConfigObject,
  writeConfigFile,
} from "../config/config.js";
import { buildConfigSchema } from "../config/schema.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { startGmailWatcher, stopGmailWatcher } from "../hooks/gmail-watcher.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { startGatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { startNodeBridgeServer } from "../infra/bridge/server.js";
import { resolveCanvasHostUrl } from "../infra/canvas-host-url.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startHeartbeatRunner } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureClawdisCliOnPath } from "../infra/path-env.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  listSystemPresence,
  upsertPresence,
} from "../infra/system-presence.js";
import {
  pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6,
} from "../infra/tailnet.js";
import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
  getTailnetHostname,
} from "../infra/tailscale.js";
import {
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "../infra/voicewake.js";
import {
  WIDE_AREA_DISCOVERY_DOMAIN,
  writeWideAreaBridgeZone,
} from "../infra/widearea-dns.js";
import { rawDataToString } from "../infra/ws.js";
import {
  createSubsystemLogger,
  getChildLogger,
  getResolvedLoggerSettings,
  runtimeForLogger,
} from "../logging.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { runExec } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import type { WizardSession } from "../wizard/session.js";
import {
  assertGatewayAuthConfigured,
  authorizeGatewayConnect,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { buildMessageWithAttachments } from "./chat-attachments.js";
import { normalizeControlUiBasePath } from "./control-ui.js";
import { resolveHooksConfig } from "./hooks.js";
import {
  isLoopbackAddress,
  isLoopbackHost,
  resolveGatewayBindHost,
} from "./net.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HANDSHAKE_TIMEOUT_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  MAX_BUFFERED_BYTES,
  MAX_CHAT_HISTORY_MESSAGES_BYTES,
  MAX_PAYLOAD_BYTES,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import {
  attachGatewayUpgradeHandler,
  createGatewayHttpServer,
  createHooksRequestHandler,
} from "./server-http.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createProviderManager } from "./server-providers.js";
import { formatError, normalizeVoiceWakeTriggers } from "./server-utils.js";
import {
  archiveFileOnDisk,
  capArrayByJsonBytes,
  listSessionsFromStore,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
} from "./session-utils.js";
import { formatForLog, logWs, summarizeAgentEventForWsLog } from "./ws-log.js";

ensureClawdisCliOnPath();

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logBridge = log.child("bridge");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logProviders = log.child("providers");
const logBrowser = log.child("browser");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logHooks = log.child("hooks");
const logWsControl = log.child("ws");
const logWhatsApp = logProviders.child("whatsapp");
const logTelegram = logProviders.child("telegram");
const logDiscord = logProviders.child("discord");
const logSignal = logProviders.child("signal");
const logIMessage = logProviders.child("imessage");
const canvasRuntime = runtimeForLogger(logCanvas);
const whatsappRuntimeEnv = runtimeForLogger(logWhatsApp);
const telegramRuntimeEnv = runtimeForLogger(logTelegram);
const discordRuntimeEnv = runtimeForLogger(logDiscord);
const signalRuntimeEnv = runtimeForLogger(logSignal);
const imessageRuntimeEnv = runtimeForLogger(logIMessage);

function resolveBonjourCliPath(): string | undefined {
  const envPath = process.env.CLAWDIS_CLI_PATH?.trim();
  if (envPath) return envPath;

  const isFile = (candidate: string) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const execDir = path.dirname(process.execPath);
  const siblingCli = path.join(execDir, "clawdis");
  if (isFile(siblingCli)) return siblingCli;

  const argvPath = process.argv[1];
  if (argvPath && isFile(argvPath)) {
    const base = path.basename(argvPath);
    if (!base.includes("gateway-daemon")) return argvPath;
  }

  const cwd = process.cwd();
  const distCli = path.join(cwd, "dist", "index.js");
  if (isFile(distCli)) return distCli;
  const binCli = path.join(cwd, "bin", "clawdis.js");
  if (isFile(binCli)) return binCli;

  return undefined;
}

let stopBrowserControlServerIfStarted: (() => Promise<void>) | null = null;

async function startBrowserControlServerIfEnabled(): Promise<void> {
  if (process.env.CLAWDIS_SKIP_BROWSER_CONTROL_SERVER === "1") return;
  // Lazy import: keeps startup fast, but still bundles for the embedded
  // gateway (bun --compile) via the static specifier path.
  const override = process.env.CLAWDIS_BROWSER_CONTROL_MODULE?.trim();
  const mod = override
    ? await import(override)
    : await import("../browser/server.js");
  stopBrowserControlServerIfStarted = mod.stopBrowserControlServer;
  await mod.startBrowserControlServerFromConfig();
}

type GatewayModelChoice = ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

async function loadGatewayModelCatalog(): Promise<GatewayModelChoice[]> {
  return await loadModelCatalog({ config: loadConfig() });
}

import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  PROTOCOL_VERSION,
  type RequestFrame,
  type SessionsCompactParams,
  type SessionsDeleteParams,
  type SessionsListParams,
  type SessionsPatchParams,
  type SessionsResetParams,
  type Snapshot,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatSendParams,
  validateConfigGetParams,
  validateConfigSchemaParams,
  validateConfigSetParams,
  validateConnectParams,
  validateModelsListParams,
  validateRequestFrame,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsResetParams,
  validateTalkModeParams,
} from "./protocol/index.js";

type Client = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
};

function formatBonjourInstanceName(displayName: string) {
  const trimmed = displayName.trim();
  if (!trimmed) return "Clawdis";
  if (/clawdis/i.test(trimmed)) return trimmed;
  return `${trimmed} (Clawdis)`;
}

async function resolveTailnetDnsHint(): Promise<string | undefined> {
  const envRaw = process.env.CLAWDIS_TAILNET_DNS?.trim();
  const env = envRaw && envRaw.length > 0 ? envRaw.replace(/\.$/, "") : "";
  if (env) return env;

  const exec: typeof runExec = (command, args) =>
    runExec(command, args, { timeoutMs: 1500, maxBuffer: 200_000 });
  try {
    return await getTailnetHostname(exec);
  } catch {
    return undefined;
  }
}

const METHODS = [
  "health",
  "providers.status",
  "status",
  "config.get",
  "config.set",
  "config.schema",
  "wizard.start",
  "wizard.next",
  "wizard.cancel",
  "wizard.status",
  "talk.mode",
  "models.list",
  "skills.status",
  "skills.install",
  "skills.update",
  "voicewake.get",
  "voicewake.set",
  "sessions.list",
  "sessions.patch",
  "sessions.reset",
  "sessions.delete",
  "sessions.compact",
  "last-heartbeat",
  "set-heartbeats",
  "wake",
  "node.pair.request",
  "node.pair.list",
  "node.pair.approve",
  "node.pair.reject",
  "node.pair.verify",
  "node.rename",
  "node.list",
  "node.describe",
  "node.invoke",
  "cron.list",
  "cron.status",
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "cron.runs",
  "system-presence",
  "system-event",
  "send",
  "agent",
  "web.login.start",
  "web.login.wait",
  "web.logout",
  "telegram.logout",
  // WebChat WebSocket-native chat methods
  "chat.history",
  "chat.abort",
  "chat.send",
];

const EVENTS = [
  "agent",
  "chat",
  "presence",
  "tick",
  "talk.mode",
  "shutdown",
  "health",
  "heartbeat",
  "cron",
  "node.pair.requested",
  "node.pair.resolved",
  "voicewake.changed",
];

export type GatewayServer = {
  close: (opts?: {
    reason?: string;
    restartExpectedMs?: number | null;
  }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer tailnet, else LAN
   */
  bind?: import("../config/config.js").BridgeBindMode;
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
   * Test-only: override the onboarding wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
};

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

function buildSnapshot(): Snapshot {
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  return {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    // Surface resolved paths so UIs can display the true config location.
    configPath: CONFIG_PATH_CLAWDIS,
    stateDir: STATE_DIR_CLAWDIS,
  };
}

type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

async function refreshHealthSnapshot(_opts?: { probe?: boolean }) {
  if (!healthRefresh) {
    healthRefresh = (async () => {
      const snap = await getHealthSnapshot(undefined);
      healthCache = snap;
      healthVersion += 1;
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
      return snap;
    })().finally(() => {
      healthRefresh = null;
    });
  }
  return healthRefresh;
}

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  const configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      throw new Error(
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacyConfig(
      configSnapshot.parsed,
    );
    if (!migrated) {
      throw new Error(
        'Legacy config entries detected but auto-migration failed. Run "clawdis doctor" to migrate.',
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

  const cfgAtStart = loadConfig();
  const bindMode = opts.bind ?? cfgAtStart.gateway?.bind ?? "loopback";
  const bindHost = opts.host ?? resolveGatewayBindHost(bindMode);
  if (!bindHost) {
    throw new Error(
      "gateway bind is tailnet, but no tailnet interface was found; refusing to start gateway",
    );
  }
  const controlUiEnabled =
    opts.controlUiEnabled ?? cfgAtStart.gateway?.controlUi?.enabled ?? true;
  const controlUiBasePath = normalizeControlUiBasePath(
    cfgAtStart.gateway?.controlUi?.basePath,
  );
  const authBase = cfgAtStart.gateway?.auth ?? {};
  const authOverrides = opts.auth ?? {};
  const authConfig = {
    ...authBase,
    ...authOverrides,
  };
  const tailscaleBase = cfgAtStart.gateway?.tailscale ?? {};
  const tailscaleOverrides = opts.tailscale ?? {};
  const tailscaleConfig = {
    ...tailscaleBase,
    ...tailscaleOverrides,
  };
  const tailscaleMode = tailscaleConfig.mode ?? "off";
  const token =
    authConfig.token ?? process.env.CLAWDIS_GATEWAY_TOKEN ?? undefined;
  const password =
    authConfig.password ?? process.env.CLAWDIS_GATEWAY_PASSWORD ?? undefined;
  const authMode: ResolvedGatewayAuth["mode"] =
    authConfig.mode ?? (password ? "password" : token ? "token" : "none");
  const allowTailscale =
    authConfig.allowTailscale ??
    (tailscaleMode === "serve" && authMode !== "password");
  const resolvedAuth: ResolvedGatewayAuth = {
    mode: authMode,
    token,
    password,
    allowTailscale,
  };
  const hooksConfig = resolveHooksConfig(cfgAtStart);
  const canvasHostEnabled =
    process.env.CLAWDIS_SKIP_CANVAS_HOST !== "1" &&
    cfgAtStart.canvasHost?.enabled !== false;
  assertGatewayAuthConfigured(resolvedAuth);
  if (tailscaleMode === "funnel" && authMode !== "password") {
    throw new Error(
      "tailscale funnel requires gateway auth mode=password (set gateway.auth.password or CLAWDIS_GATEWAY_PASSWORD)",
    );
  }
  if (tailscaleMode !== "off" && !isLoopbackHost(bindHost)) {
    throw new Error(
      "tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)",
    );
  }
  if (!isLoopbackHost(bindHost) && authMode === "none") {
    throw new Error(
      `refusing to bind gateway to ${bindHost}:${port} without auth (set gateway.auth or CLAWDIS_GATEWAY_TOKEN)`,
    );
  }

  const wizardRunner = opts.wizardRunner ?? runOnboardingWizard;
  const wizardSessions = new Map<string, WizardSession>();

  const findRunningWizard = (): string | null => {
    for (const [id, session] of wizardSessions) {
      if (session.getStatus() === "running") return id;
    }
    return null;
  };

  const purgeWizardSession = (id: string) => {
    const session = wizardSessions.get(id);
    if (!session) return;
    if (session.getStatus() === "running") return;
    wizardSessions.delete(id);
  };

  const dispatchWakeHook = (value: {
    text: string;
    mode: "now" | "next-heartbeat";
  }) => {
    enqueueSystemEvent(value.text);
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel:
      | "last"
      | "whatsapp"
      | "telegram"
      | "discord"
      | "signal"
      | "imessage";
    to?: string;
    thinking?: string;
    timeoutSeconds?: number;
  }) => {
    const sessionKey = value.sessionKey.trim()
      ? value.sessionKey.trim()
      : `hook:${randomUUID()}`;
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", atMs: now },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        channel: value.channel,
        to: value.to,
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        const summary =
          result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok"
            ? `Hook ${value.name}`
            : `Hook ${value.name} (${result.status})`;
        enqueueSystemEvent(`${prefix}: ${summary}`.trim());
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}` });
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`);
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };
  let canvasHost: CanvasHostHandler | null = null;
  let canvasHostServer: CanvasHostServer | null = null;
  if (canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: canvasRuntime,
        rootDir: cfgAtStart.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: opts.allowCanvasHostInTests,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        logCanvas.info(
          `canvas host mounted at http://${bindHost}:${port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  const handleHooksRequest = createHooksRequestHandler({
    hooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
  });

  const httpServer: HttpServer = createGatewayHttpServer({
    canvasHost,
    controlUiEnabled,
    controlUiBasePath,
    handleHooksRequest,
  });
  let bonjourStop: (() => Promise<void>) | null = null;
  let bridge: Awaited<ReturnType<typeof startNodeBridgeServer>> | null = null;
  const bridgeNodeSubscriptions = new Map<string, Set<string>>();
  const bridgeSessionSubscribers = new Map<string, Set<string>>();

  const isMobilePlatform = (platform: unknown): boolean => {
    const p = typeof platform === "string" ? platform.trim().toLowerCase() : "";
    if (!p) return false;
    return (
      p.startsWith("ios") || p.startsWith("ipados") || p.startsWith("android")
    );
  };

  const hasConnectedMobileNode = (): boolean => {
    const connected = bridge?.listConnected?.() ?? [];
    return connected.some((n) => isMobilePlatform(n.platform));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, bindHost);
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new GatewayLockError(
        `another gateway instance is already listening on ws://${bindHost}:${port}`,
        err,
      );
    }
    throw new GatewayLockError(
      `failed to bind gateway socket on ws://${bindHost}:${port}: ${String(err)}`,
      err,
    );
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  attachGatewayUpgradeHandler({ httpServer, wss, canvasHost });
  const clients = new Set<Client>();
  let seq = 0;
  // Track per-run sequence to detect out-of-order/lost agent events.
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  // Map agent runId -> pending chat runs for WebChat clients.
  const chatRunSessions = new Map<
    string,
    Array<{ sessionKey: string; clientRunId: string }>
  >();
  const addChatRun = (
    sessionId: string,
    entry: { sessionKey: string; clientRunId: string },
  ) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };
  const peekChatRun = (sessionId: string) =>
    chatRunSessions.get(sessionId)?.[0];
  const shiftChatRun = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift();
    if (!queue.length) chatRunSessions.delete(sessionId);
    return entry;
  };
  const removeChatRun = (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId &&
        (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) return undefined;
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) chatRunSessions.delete(sessionId);
    return entry;
  };
  const resolveSessionKeyForRun = (runId: string) => {
    const cached = getAgentRunContext(runId)?.sessionKey;
    if (cached) return cached;
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const found = Object.entries(store).find(
      ([, entry]) => entry?.sessionId === runId,
    );
    const sessionKey = found?.[0];
    if (sessionKey) {
      registerAgentRunContext(runId, { sessionKey });
    }
    return sessionKey;
  };
  const chatRunBuffers = new Map<string, string>();
  const chatDeltaSentAt = new Map<string, number>();
  const chatAbortControllers = new Map<
    string,
    { controller: AbortController; sessionId: string; sessionKey: string }
  >();
  setCommandLaneConcurrency("cron", cfgAtStart.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency("main", cfgAtStart.agent?.maxConcurrent ?? 1);

  const cronStorePath = resolveCronStorePath(cfgAtStart.cron?.store);
  const cronLogger = getChildLogger({
    module: "cron",
    storePath: cronStorePath,
  });
  const deps = createDefaultDeps();
  const cronEnabled =
    process.env.CLAWDIS_SKIP_CRON !== "1" && cfgAtStart.cron?.enabled !== false;
  const cron = new CronService({
    storePath: cronStorePath,
    cronEnabled,
    enqueueSystemEvent,
    requestHeartbeatNow,
    runIsolatedAgentJob: async ({ job, message }) => {
      const cfg = loadConfig();
      return await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job,
        message,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    log: cronLogger,
    onEvent: (evt) => {
      broadcast("cron", evt, { dropIfSlow: true });
      if (evt.action === "finished") {
        const logPath = resolveCronRunLogPath({
          storePath: cronStorePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
        }).catch((err) => {
          cronLogger.warn(
            { err: String(err), logPath },
            "cron: run log append failed",
          );
        });
      }
    },
  });

  const providerManager = createProviderManager({
    loadConfig,
    logWhatsApp,
    logTelegram,
    logDiscord,
    logSignal,
    logIMessage,
    whatsappRuntimeEnv,
    telegramRuntimeEnv,
    discordRuntimeEnv,
    signalRuntimeEnv,
    imessageRuntimeEnv,
  });
  const {
    getRuntimeSnapshot,
    startProviders,
    startWhatsAppProvider,
    stopWhatsAppProvider,
    stopTelegramProvider,
    stopDiscordProvider,
    stopSignalProvider,
    stopIMessageProvider,
    markWhatsAppLoggedOut,
  } = providerManager;

  const broadcast = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => {
    const eventSeq = ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    const logMeta: Record<string, unknown> = {
      event,
      seq: eventSeq,
      clients: clients.size,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    };
    if (event === "agent") {
      Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
    }
    logWs("out", "event", logMeta);
    for (const c of clients) {
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) continue;
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };

  const wideAreaDiscoveryEnabled =
    cfgAtStart.discovery?.wideArea?.enabled === true;

  const bridgeEnabled = (() => {
    if (cfgAtStart.bridge?.enabled !== undefined)
      return cfgAtStart.bridge.enabled === true;
    return process.env.CLAWDIS_BRIDGE_ENABLED !== "0";
  })();

  const bridgePort = (() => {
    if (
      typeof cfgAtStart.bridge?.port === "number" &&
      cfgAtStart.bridge.port > 0
    ) {
      return cfgAtStart.bridge.port;
    }
    if (process.env.CLAWDIS_BRIDGE_PORT !== undefined) {
      const parsed = Number.parseInt(process.env.CLAWDIS_BRIDGE_PORT, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 18790;
    }
    return 18790;
  })();

  const bridgeHost = (() => {
    // Back-compat: allow an env var override when no bind policy is configured.
    if (cfgAtStart.bridge?.bind === undefined) {
      const env = process.env.CLAWDIS_BRIDGE_HOST?.trim();
      if (env) return env;
    }

    const bind =
      cfgAtStart.bridge?.bind ?? (wideAreaDiscoveryEnabled ? "tailnet" : "lan");
    if (bind === "loopback") return "127.0.0.1";
    if (bind === "lan") return "0.0.0.0";

    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    const tailnetIPv6 = pickPrimaryTailnetIPv6();
    if (bind === "tailnet") {
      return tailnetIPv4 ?? tailnetIPv6 ?? null;
    }
    if (bind === "auto") {
      return tailnetIPv4 ?? tailnetIPv6 ?? "0.0.0.0";
    }
    return "0.0.0.0";
  })();

  const canvasHostPort = (() => {
    const configured = cfgAtStart.canvasHost?.port;
    if (typeof configured === "number" && configured > 0) return configured;
    return 18793;
  })();

  if (canvasHostEnabled && bridgeEnabled && bridgeHost) {
    try {
      const started = await startCanvasHost({
        runtime: canvasRuntime,
        rootDir: cfgAtStart.canvasHost?.root,
        port: canvasHostPort,
        listenHost: bridgeHost,
        allowInTests: opts.allowCanvasHostInTests,
      });
      if (started.port > 0) {
        canvasHostServer = started;
      }
    } catch (err) {
      logCanvas.warn(
        `failed to start on ${bridgeHost}:${canvasHostPort}: ${String(err)}`,
      );
    }
  }

  const bridgeSubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) return;

    let nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) {
      nodeSet = new Set<string>();
      bridgeNodeSubscriptions.set(normalizedNodeId, nodeSet);
    }
    if (nodeSet.has(normalizedSessionKey)) return;
    nodeSet.add(normalizedSessionKey);

    let sessionSet = bridgeSessionSubscribers.get(normalizedSessionKey);
    if (!sessionSet) {
      sessionSet = new Set<string>();
      bridgeSessionSubscribers.set(normalizedSessionKey, sessionSet);
    }
    sessionSet.add(normalizedNodeId);
  };

  const bridgeUnsubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) return;

    const nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    nodeSet?.delete(normalizedSessionKey);
    if (nodeSet?.size === 0) bridgeNodeSubscriptions.delete(normalizedNodeId);

    const sessionSet = bridgeSessionSubscribers.get(normalizedSessionKey);
    sessionSet?.delete(normalizedNodeId);
    if (sessionSet?.size === 0)
      bridgeSessionSubscribers.delete(normalizedSessionKey);
  };

  const bridgeUnsubscribeAll = (nodeId: string) => {
    const normalizedNodeId = nodeId.trim();
    const nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) return;
    for (const sessionKey of nodeSet) {
      const sessionSet = bridgeSessionSubscribers.get(sessionKey);
      sessionSet?.delete(normalizedNodeId);
      if (sessionSet?.size === 0) bridgeSessionSubscribers.delete(sessionKey);
    }
    bridgeNodeSubscriptions.delete(normalizedNodeId);
  };

  const bridgeSendToSession = (
    sessionKey: string,
    event: string,
    payload: unknown,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    const subs = bridgeSessionSubscribers.get(normalizedSessionKey);
    if (!subs || subs.size === 0) return;
    if (!bridge) return;

    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const nodeId of subs) {
      bridge.sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const bridgeSendToAllSubscribed = (event: string, payload: unknown) => {
    if (!bridge) return;
    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const nodeId of bridgeNodeSubscriptions.keys()) {
      bridge.sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const bridgeSendToAllConnected = (event: string, payload: unknown) => {
    if (!bridge) return;
    const payloadJSON = payload ? JSON.stringify(payload) : null;
    for (const node of bridge.listConnected()) {
      bridge.sendEvent({ nodeId: node.nodeId, event, payloadJSON });
    }
  };

  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    const payload = { triggers };
    broadcast("voicewake.changed", payload, { dropIfSlow: true });
    bridgeSendToAllConnected("voicewake.changed", payload);
  };

  const handleBridgeRequest = async (
    nodeId: string,
    req: { id: string; method: string; paramsJSON?: string | null },
  ): Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  > => {
    const method = req.method.trim();

    const parseParams = (): Record<string, unknown> => {
      const raw = typeof req.paramsJSON === "string" ? req.paramsJSON : "";
      const trimmed = raw.trim();
      if (!trimmed) return {};
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    };

    try {
      switch (method) {
        case "voicewake.get": {
          const cfg = await loadVoiceWakeConfig();
          return {
            ok: true,
            payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
          };
        }
        case "voicewake.set": {
          const params = parseParams();
          const triggers = normalizeVoiceWakeTriggers(params.triggers);
          const cfg = await setVoiceWakeTriggers(triggers);
          broadcastVoiceWakeChanged(cfg.triggers);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
          };
        }
        case "health": {
          const now = Date.now();
          const cached = healthCache;
          if (cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
            return { ok: true, payloadJSON: JSON.stringify(cached) };
          }
          const snap = await refreshHealthSnapshot({ probe: false });
          return { ok: true, payloadJSON: JSON.stringify(snap) };
        }
        case "config.get": {
          const params = parseParams();
          if (!validateConfigGetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
              },
            };
          }
          const snapshot = await readConfigFileSnapshot();
          return { ok: true, payloadJSON: JSON.stringify(snapshot) };
        }
        case "config.schema": {
          const params = parseParams();
          if (!validateConfigSchemaParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid config.schema params: ${formatValidationErrors(validateConfigSchemaParams.errors)}`,
              },
            };
          }
          const schema = buildConfigSchema();
          return { ok: true, payloadJSON: JSON.stringify(schema) };
        }
        case "config.set": {
          const params = parseParams();
          if (!validateConfigSetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid config.set params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
              },
            };
          }
          const rawValue = (params as { raw?: unknown }).raw;
          if (typeof rawValue !== "string") {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "invalid config.set params: raw (string) required",
              },
            };
          }
          const parsedRes = parseConfigJson5(rawValue);
          if (!parsedRes.ok) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: parsedRes.error,
              },
            };
          }
          const validated = validateConfigObject(parsedRes.parsed);
          if (!validated.ok) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "invalid config",
                details: { issues: validated.issues },
              },
            };
          }
          await writeConfigFile(validated.config);
          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              path: CONFIG_PATH_CLAWDIS,
              config: validated.config,
            }),
          };
        }
        case "talk.mode": {
          const params = parseParams();
          if (!validateTalkModeParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
              },
            };
          }
          const payload = {
            enabled: (params as { enabled: boolean }).enabled,
            phase: (params as { phase?: string }).phase ?? null,
            ts: Date.now(),
          };
          broadcast("talk.mode", payload, { dropIfSlow: true });
          return { ok: true, payloadJSON: JSON.stringify(payload) };
        }
        case "models.list": {
          const params = parseParams();
          if (!validateModelsListParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
              },
            };
          }
          const models = await loadGatewayModelCatalog();
          return { ok: true, payloadJSON: JSON.stringify({ models }) };
        }
        case "sessions.list": {
          const params = parseParams();
          if (!validateSessionsListParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
              },
            };
          }
          const p = params as SessionsListParams;
          const cfg = loadConfig();
          const storePath = resolveStorePath(cfg.session?.store);
          const store = loadSessionStore(storePath);
          const result = listSessionsFromStore({
            cfg,
            storePath,
            store,
            opts: p,
          });
          return { ok: true, payloadJSON: JSON.stringify(result) };
        }
        case "sessions.patch": {
          const params = parseParams();
          if (!validateSessionsPatchParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
              },
            };
          }

          const p = params as SessionsPatchParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const cfg = loadConfig();
          const storePath = resolveStorePath(cfg.session?.store);
          const store = loadSessionStore(storePath);
          const now = Date.now();

          const existing = store[key];
          const next: SessionEntry = existing
            ? {
                ...existing,
                updatedAt: Math.max(existing.updatedAt ?? 0, now),
              }
            : { sessionId: randomUUID(), updatedAt: now };

          if ("thinkingLevel" in p) {
            const raw = p.thinkingLevel;
            if (raw === null) {
              delete next.thinkingLevel;
            } else if (raw !== undefined) {
              const normalized = normalizeThinkLevel(String(raw));
              if (!normalized) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid thinkingLevel: ${String(raw)}`,
                  },
                };
              }
              next.thinkingLevel = normalized;
            }
          }

          if ("verboseLevel" in p) {
            const raw = p.verboseLevel;
            if (raw === null) {
              delete next.verboseLevel;
            } else if (raw !== undefined) {
              const normalized = normalizeVerboseLevel(String(raw));
              if (!normalized) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid verboseLevel: ${String(raw)}`,
                  },
                };
              }
              next.verboseLevel = normalized;
            }
          }

          if ("model" in p) {
            const raw = p.model;
            if (raw === null) {
              delete next.providerOverride;
              delete next.modelOverride;
            } else if (raw !== undefined) {
              const trimmed = String(raw).trim();
              if (!trimmed) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: "invalid model: empty",
                  },
                };
              }
              const resolvedDefault = resolveConfiguredModelRef({
                cfg,
                defaultProvider: DEFAULT_PROVIDER,
                defaultModel: DEFAULT_MODEL,
              });
              const aliasIndex = buildModelAliasIndex({
                cfg,
                defaultProvider: resolvedDefault.provider,
              });
              const resolved = resolveModelRefFromString({
                raw: trimmed,
                defaultProvider: resolvedDefault.provider,
                aliasIndex,
              });
              if (!resolved) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid model: ${trimmed}`,
                  },
                };
              }
              const catalog = await loadGatewayModelCatalog();
              const allowed = buildAllowedModelSet({
                cfg,
                catalog,
                defaultProvider: resolvedDefault.provider,
              });
              const key = modelKey(resolved.ref.provider, resolved.ref.model);
              if (!allowed.allowAny && !allowed.allowedKeys.has(key)) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `model not allowed: ${key}`,
                  },
                };
              }
              if (
                resolved.ref.provider === resolvedDefault.provider &&
                resolved.ref.model === resolvedDefault.model
              ) {
                delete next.providerOverride;
                delete next.modelOverride;
              } else {
                next.providerOverride = resolved.ref.provider;
                next.modelOverride = resolved.ref.model;
              }
            }
          }

          if ("groupActivation" in p) {
            const raw = p.groupActivation;
            if (raw === null) {
              delete next.groupActivation;
            } else if (raw !== undefined) {
              const normalized = normalizeGroupActivation(String(raw));
              if (!normalized) {
                return {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: `invalid groupActivation: ${String(raw)}`,
                  },
                };
              }
              next.groupActivation = normalized;
            }
          }

          store[key] = next;
          await saveSessionStore(storePath, store);
          const payload: SessionsPatchResult = {
            ok: true,
            path: storePath,
            key,
            entry: next,
          };
          return { ok: true, payloadJSON: JSON.stringify(payload) };
        }
        case "sessions.reset": {
          const params = parseParams();
          if (!validateSessionsResetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
              },
            };
          }

          const p = params as SessionsResetParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const { storePath, store, entry } = loadSessionEntry(key);
          const now = Date.now();
          const next: SessionEntry = {
            sessionId: randomUUID(),
            updatedAt: now,
            systemSent: false,
            abortedLastRun: false,
            thinkingLevel: entry?.thinkingLevel,
            verboseLevel: entry?.verboseLevel,
            model: entry?.model,
            contextTokens: entry?.contextTokens,
            displayName: entry?.displayName,
            chatType: entry?.chatType,
            surface: entry?.surface,
            subject: entry?.subject,
            room: entry?.room,
            space: entry?.space,
            lastChannel: entry?.lastChannel,
            lastTo: entry?.lastTo,
            skillsSnapshot: entry?.skillsSnapshot,
          };
          store[key] = next;
          await saveSessionStore(storePath, store);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ ok: true, key, entry: next }),
          };
        }
        case "sessions.delete": {
          const params = parseParams();
          if (!validateSessionsDeleteParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
              },
            };
          }

          const p = params as SessionsDeleteParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const deleteTranscript =
            typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

          const { storePath, store, entry } = loadSessionEntry(key);
          const sessionId = entry?.sessionId;
          const existed = Boolean(store[key]);
          if (existed) delete store[key];
          await saveSessionStore(storePath, store);

          const archived: string[] = [];
          if (deleteTranscript && sessionId) {
            for (const candidate of resolveSessionTranscriptCandidates(
              sessionId,
              storePath,
            )) {
              if (!fs.existsSync(candidate)) continue;
              try {
                archived.push(archiveFileOnDisk(candidate, "deleted"));
              } catch {
                // Best-effort; deleting the store entry is the main operation.
              }
            }
          }

          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              key,
              deleted: existed,
              archived,
            }),
          };
        }
        case "sessions.compact": {
          const params = parseParams();
          if (!validateSessionsCompactParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
              },
            };
          }

          const p = params as SessionsCompactParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const maxLines =
            typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
              ? Math.max(1, Math.floor(p.maxLines))
              : 400;

          const { storePath, store, entry } = loadSessionEntry(key);
          const sessionId = entry?.sessionId;
          if (!sessionId) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                reason: "no sessionId",
              }),
            };
          }

          const filePath = resolveSessionTranscriptCandidates(
            sessionId,
            storePath,
          ).find((candidate) => fs.existsSync(candidate));
          if (!filePath) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                reason: "no transcript",
              }),
            };
          }

          const raw = fs.readFileSync(filePath, "utf-8");
          const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
          if (lines.length <= maxLines) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                kept: lines.length,
              }),
            };
          }

          const archived = archiveFileOnDisk(filePath, "bak");
          const keptLines = lines.slice(-maxLines);
          fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

          // Token counts no longer match; clear so status + UI reflect reality after the next turn.
          if (store[key]) {
            delete store[key].inputTokens;
            delete store[key].outputTokens;
            delete store[key].totalTokens;
            store[key].updatedAt = Date.now();
            await saveSessionStore(storePath, store);
          }

          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              key,
              compacted: true,
              archived,
              kept: keptLines.length,
            }),
          };
        }
        case "chat.history": {
          const params = parseParams();
          if (!validateChatHistoryParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
              },
            };
          }
          const { sessionKey, limit } = params as {
            sessionKey: string;
            limit?: number;
          };
          const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
          const sessionId = entry?.sessionId;
          const rawMessages =
            sessionId && storePath
              ? readSessionMessages(sessionId, storePath)
              : [];
          const max = typeof limit === "number" ? limit : 200;
          const sliced =
            rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
          const capped = capArrayByJsonBytes(
            sliced,
            MAX_CHAT_HISTORY_MESSAGES_BYTES,
          ).items;
          let thinkingLevel = entry?.thinkingLevel;
          if (!thinkingLevel) {
            const configured = cfg.agent?.thinkingDefault;
            if (configured) {
              thinkingLevel = configured;
            } else {
              const { provider, model } = resolveSessionModelRef(cfg, entry);
              const catalog = await loadGatewayModelCatalog();
              thinkingLevel = resolveThinkingDefault({
                cfg,
                provider,
                model,
                catalog,
              });
            }
          }
          return {
            ok: true,
            payloadJSON: JSON.stringify({
              sessionKey,
              sessionId,
              messages: capped,
              thinkingLevel,
            }),
          };
        }
        case "chat.abort": {
          const params = parseParams();
          if (!validateChatAbortParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
              },
            };
          }

          const { sessionKey, runId } = params as {
            sessionKey: string;
            runId: string;
          };
          const active = chatAbortControllers.get(runId);
          if (!active) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({ ok: true, aborted: false }),
            };
          }
          if (active.sessionKey !== sessionKey) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "runId does not match sessionKey",
              },
            };
          }

          active.controller.abort();
          chatAbortControllers.delete(runId);
          chatRunBuffers.delete(runId);
          chatDeltaSentAt.delete(runId);
          removeChatRun(active.sessionId, runId, sessionKey);

          const payload = {
            runId,
            sessionKey,
            seq: (agentRunSeq.get(active.sessionId) ?? 0) + 1,
            state: "aborted" as const,
          };
          broadcast("chat", payload);
          bridgeSendToSession(sessionKey, "chat", payload);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ ok: true, aborted: true }),
          };
        }
        case "chat.send": {
          const params = parseParams();
          if (!validateChatSendParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
              },
            };
          }

          const p = params as {
            sessionKey: string;
            message: string;
            thinking?: string;
            deliver?: boolean;
            attachments?: Array<{
              type?: string;
              mimeType?: string;
              fileName?: string;
              content?: unknown;
            }>;
            timeoutMs?: number;
            idempotencyKey: string;
          };
          const timeoutMs = Math.min(
            Math.max(p.timeoutMs ?? 30_000, 0),
            30_000,
          );
          const normalizedAttachments =
            p.attachments?.map((a) => ({
              type: typeof a?.type === "string" ? a.type : undefined,
              mimeType:
                typeof a?.mimeType === "string" ? a.mimeType : undefined,
              fileName:
                typeof a?.fileName === "string" ? a.fileName : undefined,
              content:
                typeof a?.content === "string"
                  ? a.content
                  : ArrayBuffer.isView(a?.content)
                    ? Buffer.from(
                        a.content.buffer,
                        a.content.byteOffset,
                        a.content.byteLength,
                      ).toString("base64")
                    : undefined,
            })) ?? [];

          let messageWithAttachments = p.message;
          if (normalizedAttachments.length > 0) {
            try {
              messageWithAttachments = buildMessageWithAttachments(
                p.message,
                normalizedAttachments,
                { maxBytes: 5_000_000 },
              );
            } catch (err) {
              return {
                ok: false,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: String(err),
                },
              };
            }
          }

          const { storePath, store, entry } = loadSessionEntry(p.sessionKey);
          const now = Date.now();
          const sessionId = entry?.sessionId ?? randomUUID();
          const sessionEntry: SessionEntry = {
            sessionId,
            updatedAt: now,
            thinkingLevel: entry?.thinkingLevel,
            verboseLevel: entry?.verboseLevel,
            systemSent: entry?.systemSent,
            lastChannel: entry?.lastChannel,
            lastTo: entry?.lastTo,
          };
          const clientRunId = p.idempotencyKey;

          const cached = dedupe.get(`chat:${clientRunId}`);
          if (cached) {
            if (cached.ok) {
              return { ok: true, payloadJSON: JSON.stringify(cached.payload) };
            }
            return {
              ok: false,
              error: cached.error ?? {
                code: ErrorCodes.UNAVAILABLE,
                message: "request failed",
              },
            };
          }

          try {
            const abortController = new AbortController();
            chatAbortControllers.set(clientRunId, {
              controller: abortController,
              sessionId,
              sessionKey: p.sessionKey,
            });
            addChatRun(sessionId, { sessionKey: p.sessionKey, clientRunId });

            if (store) {
              store[p.sessionKey] = sessionEntry;
              if (storePath) {
                await saveSessionStore(storePath, store);
              }
            }

            await agentCommand(
              {
                message: messageWithAttachments,
                sessionId,
                thinking: p.thinking,
                deliver: p.deliver,
                timeout: Math.ceil(timeoutMs / 1000).toString(),
                surface: `Node(${nodeId})`,
                abortSignal: abortController.signal,
              },
              defaultRuntime,
              deps,
            );
            const payload = {
              runId: clientRunId,
              status: "ok" as const,
            };
            dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: true,
              payload,
            });
            return { ok: true, payloadJSON: JSON.stringify(payload) };
          } catch (err) {
            const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
            const payload = {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            };
            dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: false,
              payload,
              error,
            });
            return {
              ok: false,
              error: error ?? {
                code: ErrorCodes.UNAVAILABLE,
                message: String(err),
              },
            };
          } finally {
            chatAbortControllers.delete(clientRunId);
          }
        }
        default:
          return {
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "Method not allowed",
              details: { method },
            },
          };
      }
    } catch (err) {
      return {
        ok: false,
        error: { code: ErrorCodes.INVALID_REQUEST, message: String(err) },
      };
    }
  };

  const handleBridgeEvent = async (
    nodeId: string,
    evt: { event: string; payloadJSON?: string | null },
  ) => {
    switch (evt.event) {
      case "voice.transcript": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const text = typeof obj.text === "string" ? obj.text.trim() : "";
        if (!text) return;
        if (text.length > 20_000) return;
        const sessionKeyRaw =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        const mainKey =
          (loadConfig().session?.mainKey ?? "main").trim() || "main";
        const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : mainKey;
        const { storePath, store, entry } = loadSessionEntry(sessionKey);
        const now = Date.now();
        const sessionId = entry?.sessionId ?? randomUUID();
        store[sessionKey] = {
          sessionId,
          updatedAt: now,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          systemSent: entry?.systemSent,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
        };
        if (storePath) {
          await saveSessionStore(storePath, store);
        }

        // Ensure chat UI clients refresh when this run completes (even though it wasn't started via chat.send).
        // This maps agent bus events (keyed by sessionId) to chat events (keyed by clientRunId).
        addChatRun(sessionId, {
          sessionKey,
          clientRunId: `voice-${randomUUID()}`,
        });

        void agentCommand(
          {
            message: text,
            sessionId,
            thinking: "low",
            deliver: false,
            surface: "Node",
          },
          defaultRuntime,
          deps,
        ).catch((err) => {
          logBridge.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
        });
        return;
      }
      case "agent.request": {
        if (!evt.payloadJSON) return;
        type AgentDeepLink = {
          message?: string;
          sessionKey?: string | null;
          thinking?: string | null;
          deliver?: boolean;
          to?: string | null;
          channel?: string | null;
          timeoutSeconds?: number | null;
          key?: string | null;
        };
        let link: AgentDeepLink | null = null;
        try {
          link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
        } catch {
          return;
        }
        const message = (link?.message ?? "").trim();
        if (!message) return;
        if (message.length > 20_000) return;

        const channelRaw =
          typeof link?.channel === "string" ? link.channel.trim() : "";
        const channel = channelRaw.toLowerCase();
        const provider =
          channel === "whatsapp" ||
          channel === "telegram" ||
          channel === "signal" ||
          channel === "imessage"
            ? channel
            : undefined;
        const to =
          typeof link?.to === "string" && link.to.trim()
            ? link.to.trim()
            : undefined;
        const deliver = Boolean(link?.deliver) && Boolean(provider);

        const sessionKeyRaw = (link?.sessionKey ?? "").trim();
        const sessionKey =
          sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
        const { storePath, store, entry } = loadSessionEntry(sessionKey);
        const now = Date.now();
        const sessionId = entry?.sessionId ?? randomUUID();
        store[sessionKey] = {
          sessionId,
          updatedAt: now,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          systemSent: entry?.systemSent,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
        };
        if (storePath) {
          await saveSessionStore(storePath, store);
        }

        void agentCommand(
          {
            message,
            sessionId,
            thinking: link?.thinking ?? undefined,
            deliver,
            to,
            provider,
            timeout:
              typeof link?.timeoutSeconds === "number"
                ? link.timeoutSeconds.toString()
                : undefined,
            surface: "Node",
          },
          defaultRuntime,
          deps,
        ).catch((err) => {
          logBridge.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
        });
        return;
      }
      case "chat.subscribe": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const sessionKey =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        if (!sessionKey) return;
        bridgeSubscribe(nodeId, sessionKey);
        return;
      }
      case "chat.unsubscribe": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const sessionKey =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        if (!sessionKey) return;
        bridgeUnsubscribe(nodeId, sessionKey);
        return;
      }
      default:
        return;
    }
  };

  const machineDisplayName = await getMachineDisplayName();
  const canvasHostPortForBridge = canvasHostServer?.port;
  const canvasHostHostForBridge =
    canvasHostServer &&
    bridgeHost &&
    bridgeHost !== "0.0.0.0" &&
    bridgeHost !== "::"
      ? bridgeHost
      : undefined;

  if (bridgeEnabled && bridgePort > 0 && bridgeHost) {
    try {
      const started = await startNodeBridgeServer({
        host: bridgeHost,
        port: bridgePort,
        serverName: machineDisplayName,
        canvasHostPort: canvasHostPortForBridge,
        canvasHostHost: canvasHostHostForBridge,
        onRequest: (nodeId, req) => handleBridgeRequest(nodeId, req),
        onAuthenticated: async (node) => {
          const host = node.displayName?.trim() || node.nodeId;
          const ip = node.remoteIp?.trim();
          const version = node.version?.trim() || "unknown";
          const platform = node.platform?.trim() || undefined;
          const deviceFamily = node.deviceFamily?.trim() || undefined;
          const modelIdentifier = node.modelIdentifier?.trim() || undefined;
          const text = `Node: ${host}${ip ? ` (${ip})` : ""} · app ${version} · last input 0s ago · mode remote · reason node-connected`;
          upsertPresence(node.nodeId, {
            host,
            ip,
            version,
            platform,
            deviceFamily,
            modelIdentifier,
            mode: "remote",
            reason: "node-connected",
            lastInputSeconds: 0,
            instanceId: node.nodeId,
            text,
          });
          presenceVersion += 1;
          broadcast(
            "presence",
            { presence: listSystemPresence() },
            {
              dropIfSlow: true,
              stateVersion: {
                presence: presenceVersion,
                health: healthVersion,
              },
            },
          );

          try {
            const cfg = await loadVoiceWakeConfig();
            started.sendEvent({
              nodeId: node.nodeId,
              event: "voicewake.changed",
              payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
            });
          } catch {
            // Best-effort only.
          }
        },
        onDisconnected: (node) => {
          bridgeUnsubscribeAll(node.nodeId);
          const host = node.displayName?.trim() || node.nodeId;
          const ip = node.remoteIp?.trim();
          const version = node.version?.trim() || "unknown";
          const platform = node.platform?.trim() || undefined;
          const deviceFamily = node.deviceFamily?.trim() || undefined;
          const modelIdentifier = node.modelIdentifier?.trim() || undefined;
          const text = `Node: ${host}${ip ? ` (${ip})` : ""} · app ${version} · last input 0s ago · mode remote · reason node-disconnected`;
          upsertPresence(node.nodeId, {
            host,
            ip,
            version,
            platform,
            deviceFamily,
            modelIdentifier,
            mode: "remote",
            reason: "node-disconnected",
            lastInputSeconds: 0,
            instanceId: node.nodeId,
            text,
          });
          presenceVersion += 1;
          broadcast(
            "presence",
            { presence: listSystemPresence() },
            {
              dropIfSlow: true,
              stateVersion: {
                presence: presenceVersion,
                health: healthVersion,
              },
            },
          );
        },
        onEvent: handleBridgeEvent,
        onPairRequested: (request) => {
          broadcast("node.pair.requested", request, { dropIfSlow: true });
        },
      });
      if (started.port > 0) {
        bridge = started;
        logBridge.info(
          `listening on tcp://${bridgeHost}:${bridge.port} (node)`,
        );
      }
    } catch (err) {
      logBridge.warn(`failed to start: ${String(err)}`);
    }
  } else if (bridgeEnabled && bridgePort > 0 && !bridgeHost) {
    logBridge.warn(
      "bind policy requested tailnet IP, but no tailnet interface was found; refusing to start bridge",
    );
  }

  const tailnetDns = await resolveTailnetDnsHint();

  try {
    const sshPortEnv = process.env.CLAWDIS_SSH_PORT?.trim();
    const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
    const sshPort =
      Number.isFinite(sshPortParsed) && sshPortParsed > 0
        ? sshPortParsed
        : undefined;

    const bonjour = await startGatewayBonjourAdvertiser({
      instanceName: formatBonjourInstanceName(machineDisplayName),
      gatewayPort: port,
      bridgePort: bridge?.port,
      canvasPort: canvasHostPortForBridge,
      sshPort,
      tailnetDns,
      cliPath: resolveBonjourCliPath(),
    });
    bonjourStop = bonjour.stop;
  } catch (err) {
    logDiscovery.warn(`bonjour advertising failed: ${String(err)}`);
  }

  if (wideAreaDiscoveryEnabled && bridge?.port) {
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaBridgeZone({
          bridgePort: bridge.port,
          displayName: formatBonjourInstanceName(machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
          tailnetDns,
        });
        logDiscovery.info(
          `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${WIDE_AREA_DISCOVERY_DOMAIN} → ${result.zonePath})`,
        );
      } catch (err) {
        logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
      }
    }
  }

  broadcastHealthUpdate = (snap: HealthSummary) => {
    broadcast("health", snap, {
      stateVersion: { presence: presenceVersion, health: healthVersion },
    });
    bridgeSendToAllSubscribed("health", snap);
  };

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    broadcast("tick", payload, { dropIfSlow: true });
    bridgeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // periodic health refresh to keep cached snapshot warm
  const healthInterval = setInterval(() => {
    void refreshHealthSnapshot({ probe: true }).catch((err) =>
      logHealth.error(`refresh failed: ${formatError(err)}`),
    );
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void refreshHealthSnapshot({ probe: true }).catch((err) =>
    logHealth.error(`initial refresh failed: ${formatError(err)}`),
  );

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of dedupe) {
      if (now - v.ts > DEDUPE_TTL_MS) dedupe.delete(k);
    }
    if (dedupe.size > DEDUPE_MAX) {
      const entries = [...dedupe.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < dedupe.size - DEDUPE_MAX; i++) {
        dedupe.delete(entries[i][0]);
      }
    }
  }, 60_000);

  const agentUnsub = onAgentEvent((evt) => {
    const last = agentRunSeq.get(evt.runId) ?? 0;
    if (evt.seq !== last + 1) {
      // Fan out an error event so clients can refresh the stream on gaps.
      broadcast("agent", {
        runId: evt.runId,
        stream: "error",
        ts: Date.now(),
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    broadcast("agent", evt);

    const chatLink = peekChatRun(evt.runId);
    const sessionKey =
      chatLink?.sessionKey ?? resolveSessionKeyForRun(evt.runId);
    const jobState =
      evt.stream === "job" && typeof evt.data?.state === "string"
        ? evt.data.state
        : null;

    if (sessionKey) {
      if (chatLink) {
        // Map agent bus events to chat events for WS WebChat clients.
        // Use clientRunId so the webchat can correlate with its pending promise.
        const { clientRunId } = chatLink;
        bridgeSendToSession(sessionKey, "agent", evt);
        if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
          const base = {
            runId: clientRunId,
            sessionKey,
            seq: evt.seq,
          };
          chatRunBuffers.set(clientRunId, evt.data.text);
          const now = Date.now();
          const last = chatDeltaSentAt.get(clientRunId) ?? 0;
          // Throttle UI delta events so slow clients don't accumulate unbounded buffers.
          if (now - last >= 150) {
            chatDeltaSentAt.set(clientRunId, now);
            const payload = {
              ...base,
              state: "delta" as const,
              message: {
                role: "assistant",
                content: [{ type: "text", text: evt.data.text }],
                timestamp: now,
              },
            };
            broadcast("chat", payload, { dropIfSlow: true });
            bridgeSendToSession(sessionKey, "chat", payload);
          }
        } else if (jobState === "done" || jobState === "error") {
          const finished = shiftChatRun(evt.runId);
          if (!finished) {
            if (jobState) clearAgentRunContext(evt.runId);
            return;
          }
          const { sessionKey: finishedSessionKey, clientRunId: finishedRunId } =
            finished;
          const base = {
            runId: finishedRunId,
            sessionKey: finishedSessionKey,
            seq: evt.seq,
          };
          const text = chatRunBuffers.get(finishedRunId)?.trim() ?? "";
          chatRunBuffers.delete(finishedRunId);
          chatDeltaSentAt.delete(finishedRunId);
          if (jobState === "done") {
            const payload = {
              ...base,
              state: "final",
              message: text
                ? {
                    role: "assistant",
                    content: [{ type: "text", text }],
                    timestamp: Date.now(),
                  }
                : undefined,
            };
            broadcast("chat", payload);
            bridgeSendToSession(finishedSessionKey, "chat", payload);
          } else {
            const payload = {
              ...base,
              state: "error",
              errorMessage: evt.data.error
                ? formatForLog(evt.data.error)
                : undefined,
            };
            broadcast("chat", payload);
            bridgeSendToSession(finishedSessionKey, "chat", payload);
          }
        }
      } else {
        const clientRunId = evt.runId;
        bridgeSendToSession(sessionKey, "agent", evt);
        if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
          const base = {
            runId: clientRunId,
            sessionKey,
            seq: evt.seq,
          };
          chatRunBuffers.set(clientRunId, evt.data.text);
          const now = Date.now();
          const last = chatDeltaSentAt.get(clientRunId) ?? 0;
          if (now - last >= 150) {
            chatDeltaSentAt.set(clientRunId, now);
            const payload = {
              ...base,
              state: "delta" as const,
              message: {
                role: "assistant",
                content: [{ type: "text", text: evt.data.text }],
                timestamp: now,
              },
            };
            broadcast("chat", payload, { dropIfSlow: true });
            bridgeSendToSession(sessionKey, "chat", payload);
          }
        } else if (jobState === "done" || jobState === "error") {
          const base = {
            runId: clientRunId,
            sessionKey,
            seq: evt.seq,
          };
          const text = chatRunBuffers.get(clientRunId)?.trim() ?? "";
          chatRunBuffers.delete(clientRunId);
          chatDeltaSentAt.delete(clientRunId);
          if (jobState === "done") {
            const payload = {
              ...base,
              state: "final",
              message: text
                ? {
                    role: "assistant",
                    content: [{ type: "text", text }],
                    timestamp: Date.now(),
                  }
                : undefined,
            };
            broadcast("chat", payload);
            bridgeSendToSession(sessionKey, "chat", payload);
          } else {
            const payload = {
              ...base,
              state: "error",
              errorMessage: evt.data.error
                ? formatForLog(evt.data.error)
                : undefined,
            };
            broadcast("chat", payload);
            bridgeSendToSession(sessionKey, "chat", payload);
          }
        }
      }
    }

    if (jobState === "done" || jobState === "error") {
      clearAgentRunContext(evt.runId);
    }
  });

  const heartbeatUnsub = onHeartbeatEvent((evt) => {
    broadcast("heartbeat", evt, { dropIfSlow: true });
  });

  const heartbeatRunner = startHeartbeatRunner({ cfg: cfgAtStart });

  void cron
    .start()
    .catch((err) => logCron.error(`failed to start: ${String(err)}`));

  wss.on("connection", (socket, upgradeReq) => {
    let client: Client | null = null;
    let closed = false;
    const connId = randomUUID();
    const remoteAddr = (
      socket as WebSocket & { _socket?: { remoteAddress?: string } }
    )._socket?.remoteAddress;
    const canvasHostPortForWs =
      canvasHostServer?.port ?? (canvasHost ? port : undefined);
    const canvasHostOverride =
      bridgeHost && bridgeHost !== "0.0.0.0" && bridgeHost !== "::"
        ? bridgeHost
        : undefined;
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort: canvasHostPortForWs,
      hostOverride: canvasHostServer ? canvasHostOverride : undefined,
      requestHost: upgradeReq.headers.host,
      forwardedProto: upgradeReq.headers["x-forwarded-proto"],
      localAddress: upgradeReq.socket?.localAddress,
    });
    logWs("in", "open", { connId, remoteAddr });
    const isWebchatConnect = (params: ConnectParams | null | undefined) =>
      params?.client?.mode === "webchat" ||
      params?.client?.name === "webchat-ui";

    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      if (client) clients.delete(client);
      try {
        socket.close(1000);
      } catch {
        /* ignore */
      }
    };

    socket.once("error", (err) => {
      logWsControl.warn(
        `error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`,
      );
      close();
    });
    socket.once("close", (code, reason) => {
      if (!client) {
        logWsControl.warn(
          `closed before connect conn=${connId} remote=${remoteAddr ?? "?"} code=${code ?? "n/a"} reason=${reason?.toString() || "n/a"}`,
        );
      }
      if (client && isWebchatConnect(client.connect)) {
        logWsControl.info(
          `webchat disconnected code=${code} reason=${reason?.toString() || "n/a"} conn=${connId}`,
        );
      }
      if (client?.presenceKey) {
        // mark presence as disconnected
        upsertPresence(client.presenceKey, {
          reason: "disconnect",
        });
        presenceVersion += 1;
        broadcast(
          "presence",
          { presence: listSystemPresence() },
          {
            dropIfSlow: true,
            stateVersion: { presence: presenceVersion, health: healthVersion },
          },
        );
      }
      logWs("out", "close", {
        connId,
        code,
        reason: reason?.toString(),
      });
      close();
    });

    const handshakeTimer = setTimeout(() => {
      if (!client) {
        logWsControl.warn(
          `handshake timeout conn=${connId} remote=${remoteAddr ?? "?"}`,
        );
        close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on("message", async (data) => {
      if (closed) return;
      const text = rawDataToString(data);
      try {
        const parsed = JSON.parse(text);
        if (!client) {
          // Handshake must be a normal request:
          // { type:"req", method:"connect", params: ConnectParams }.
          if (
            !validateRequestFrame(parsed) ||
            (parsed as RequestFrame).method !== "connect" ||
            !validateConnectParams((parsed as RequestFrame).params)
          ) {
            if (validateRequestFrame(parsed)) {
              const req = parsed as RequestFrame;
              send({
                type: "res",
                id: req.id,
                ok: false,
                error: errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  req.method === "connect"
                    ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`
                    : "invalid handshake: first request must be connect",
                ),
              });
            } else {
              logWsControl.warn(
                `invalid handshake conn=${connId} remote=${remoteAddr ?? "?"}`,
              );
            }
            socket.close(1008, "invalid handshake");
            close();
            return;
          }

          const frame = parsed as RequestFrame;
          const connectParams = frame.params as ConnectParams;

          // protocol negotiation
          const { minProtocol, maxProtocol } = connectParams;
          if (
            maxProtocol < PROTOCOL_VERSION ||
            minProtocol > PROTOCOL_VERSION
          ) {
            logWsControl.warn(
              `protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(
                ErrorCodes.INVALID_REQUEST,
                "protocol mismatch",
                {
                  details: { expectedProtocol: PROTOCOL_VERSION },
                },
              ),
            });
            socket.close(1002, "protocol mismatch");
            close();
            return;
          }

          const authResult = await authorizeGatewayConnect({
            auth: resolvedAuth,
            connectAuth: connectParams.auth,
            req: upgradeReq,
          });
          if (!authResult.ok) {
            logWsControl.warn(
              `unauthorized conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"),
            });
            socket.close(1008, "unauthorized");
            close();
            return;
          }
          const authMethod = authResult.method ?? "none";

          const shouldTrackPresence = connectParams.client.mode !== "cli";
          const presenceKey = shouldTrackPresence
            ? connectParams.client.instanceId || connId
            : undefined;

          logWs("in", "connect", {
            connId,
            client: connectParams.client.name,
            version: connectParams.client.version,
            mode: connectParams.client.mode,
            instanceId: connectParams.client.instanceId,
            platform: connectParams.client.platform,
            auth: authMethod,
          });

          if (isWebchatConnect(connectParams)) {
            logWsControl.info(
              `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${connectParams.client.name} ${connectParams.client.mode} v${connectParams.client.version}`,
            );
          }

          if (presenceKey) {
            upsertPresence(presenceKey, {
              host: connectParams.client.name || os.hostname(),
              ip: isLoopbackAddress(remoteAddr) ? undefined : remoteAddr,
              version: connectParams.client.version,
              platform: connectParams.client.platform,
              deviceFamily: connectParams.client.deviceFamily,
              modelIdentifier: connectParams.client.modelIdentifier,
              mode: connectParams.client.mode,
              instanceId: connectParams.client.instanceId,
              reason: "connect",
            });
            presenceVersion += 1;
          }

          const snapshot = buildSnapshot();
          if (healthCache) {
            snapshot.health = healthCache;
            snapshot.stateVersion.health = healthVersion;
          }
          const helloOk = {
            type: "hello-ok",
            protocol: PROTOCOL_VERSION,
            server: {
              version:
                process.env.CLAWDIS_VERSION ??
                process.env.npm_package_version ??
                "dev",
              commit: process.env.GIT_COMMIT,
              host: os.hostname(),
              connId,
            },
            features: { methods: METHODS, events: EVENTS },
            snapshot,
            canvasHostUrl,
            policy: {
              maxPayload: MAX_PAYLOAD_BYTES,
              maxBufferedBytes: MAX_BUFFERED_BYTES,
              tickIntervalMs: TICK_INTERVAL_MS,
            },
          };

          clearTimeout(handshakeTimer);
          client = { socket, connect: connectParams, connId, presenceKey };

          logWs("out", "hello-ok", {
            connId,
            methods: METHODS.length,
            events: EVENTS.length,
            presence: snapshot.presence.length,
            stateVersion: snapshot.stateVersion.presence,
          });

          send({ type: "res", id: frame.id, ok: true, payload: helloOk });

          clients.add(client);
          void refreshHealthSnapshot({ probe: true }).catch((err) =>
            logHealth.error(
              `post-connect health refresh failed: ${formatError(err)}`,
            ),
          );
          return;
        }

        // After handshake, accept only req frames
        if (!validateRequestFrame(parsed)) {
          send({
            type: "res",
            id: (parsed as { id?: unknown })?.id ?? "invalid",
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
            ),
          });
          return;
        }
        const req = parsed as RequestFrame;
        logWs("in", "req", {
          connId,
          id: req.id,
          method: req.method,
        });
        const respond = (
          ok: boolean,
          payload?: unknown,
          error?: ErrorShape,
          meta?: Record<string, unknown>,
        ) => {
          send({ type: "res", id: req.id, ok, payload, error });
          logWs("out", "res", {
            connId,
            id: req.id,
            ok,
            method: req.method,
            errorCode: error?.code,
            errorMessage: error?.message,
            ...meta,
          });
        };

        void (async () => {
          await handleGatewayRequest({
            req,
            respond,
            client,
            isWebchatConnect,
            context: {
              deps,
              cron,
              cronStorePath,
              loadGatewayModelCatalog,
              getHealthCache: () => healthCache,
              refreshHealthSnapshot,
              logHealth,
              incrementPresenceVersion: () => {
                presenceVersion += 1;
                return presenceVersion;
              },
              getHealthVersion: () => healthVersion,
              broadcast,
              bridge,
              bridgeSendToSession,
              hasConnectedMobileNode,
              agentRunSeq,
              chatAbortControllers,
              chatRunBuffers,
              chatDeltaSentAt,
              addChatRun,
              removeChatRun,
              dedupe,
              wizardSessions,
              findRunningWizard,
              purgeWizardSession,
              getRuntimeSnapshot,
              startWhatsAppProvider,
              stopWhatsAppProvider,
              stopTelegramProvider,
              markWhatsAppLoggedOut,
              wizardRunner,
              broadcastVoiceWakeChanged,
            },
          });
        })().catch((err) => {
          log.error(`request handler failed: ${formatForLog(err)}`);
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
          );
        });
      } catch (err) {
        log.error(`parse/handle error: ${String(err)}`);
        logWs("out", "parse-error", { connId, error: formatForLog(err) });
        // If still in handshake, close; otherwise respond error
        if (!client) {
          close();
        }
      }
    });
  });

  const { provider: agentProvider, model: agentModel } =
    resolveConfiguredModelRef({
      cfg: cfgAtStart,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
  const modelRef = `${agentProvider}/${agentModel}`;
  log.info(`agent model: ${modelRef}`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
  });
  log.info(`listening on ws://${bindHost}:${port} (PID ${process.pid})`);
  log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (isNixMode) {
    log.info("gateway: running in Nix mode (config managed externally)");
  }
  let tailscaleCleanup: (() => Promise<void>) | null = null;
  if (tailscaleMode !== "off") {
    try {
      if (tailscaleMode === "serve") {
        await enableTailscaleServe(port);
      } else {
        await enableTailscaleFunnel(port);
      }
      const host = await getTailnetHostname().catch(() => null);
      if (host) {
        const uiPath = controlUiBasePath ? `${controlUiBasePath}/` : "/";
        logTailscale.info(
          `${tailscaleMode} enabled: https://${host}${uiPath} (WS via wss://${host})`,
        );
      } else {
        logTailscale.info(`${tailscaleMode} enabled`);
      }
    } catch (err) {
      logTailscale.warn(
        `${tailscaleMode} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (tailscaleConfig.resetOnExit) {
      tailscaleCleanup = async () => {
        try {
          if (tailscaleMode === "serve") {
            await disableTailscaleServe();
          } else {
            await disableTailscaleFunnel();
          }
        } catch (err) {
          logTailscale.warn(
            `${tailscaleMode} cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };
    }
  }

  // Start clawd browser control server (unless disabled via config).
  try {
    await startBrowserControlServerIfEnabled();
  } catch (err) {
    logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  if (process.env.CLAWDIS_SKIP_GMAIL_WATCHER !== "1") {
    try {
      const gmailResult = await startGmailWatcher(cfgAtStart);
      if (gmailResult.started) {
        logHooks.info("gmail watcher started");
      } else if (
        gmailResult.reason &&
        gmailResult.reason !== "hooks not enabled" &&
        gmailResult.reason !== "no gmail account configured"
      ) {
        logHooks.warn(`gmail watcher not started: ${gmailResult.reason}`);
      }
    } catch (err) {
      logHooks.error(`gmail watcher failed to start: ${String(err)}`);
    }
  }

  // Launch configured providers (WhatsApp Web, Discord, Telegram) so gateway replies via the
  // surface the message came from. Tests can opt out via CLAWDIS_SKIP_PROVIDERS.
  if (process.env.CLAWDIS_SKIP_PROVIDERS !== "1") {
    try {
      await startProviders();
    } catch (err) {
      logProviders.error(`provider startup failed: ${String(err)}`);
    }
  } else {
    logProviders.info("skipping provider start (CLAWDIS_SKIP_PROVIDERS=1)");
  }

  return {
    close: async (opts) => {
      const reasonRaw =
        typeof opts?.reason === "string" ? opts.reason.trim() : "";
      const reason = reasonRaw || "gateway stopping";
      const restartExpectedMs =
        typeof opts?.restartExpectedMs === "number" &&
        Number.isFinite(opts.restartExpectedMs)
          ? Math.max(0, Math.floor(opts.restartExpectedMs))
          : null;
      if (bonjourStop) {
        try {
          await bonjourStop();
        } catch {
          /* ignore */
        }
      }
      if (tailscaleCleanup) {
        await tailscaleCleanup();
      }
      if (canvasHost) {
        try {
          await canvasHost.close();
        } catch {
          /* ignore */
        }
      }
      if (canvasHostServer) {
        try {
          await canvasHostServer.close();
        } catch {
          /* ignore */
        }
      }
      if (bridge) {
        try {
          await bridge.close();
        } catch {
          /* ignore */
        }
      }
      await stopWhatsAppProvider();
      await stopTelegramProvider();
      await stopDiscordProvider();
      await stopSignalProvider();
      await stopIMessageProvider();
      await stopGmailWatcher();
      cron.stop();
      heartbeatRunner.stop();
      broadcast("shutdown", {
        reason,
        restartExpectedMs,
      });
      clearInterval(tickInterval);
      clearInterval(healthInterval);
      clearInterval(dedupeCleanup);
      if (agentUnsub) {
        try {
          agentUnsub();
        } catch {
          /* ignore */
        }
      }
      if (heartbeatUnsub) {
        try {
          heartbeatUnsub();
        } catch {
          /* ignore */
        }
      }
      chatRunSessions.clear();
      chatRunBuffers.clear();
      for (const c of clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      if (stopBrowserControlServerIfStarted) {
        await stopBrowserControlServerIfStarted().catch(() => {});
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
