import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.js";
import {
  type ConfigFileSnapshot,
  type OpenClawConfig,
  applyConfigOverrides,
  getRuntimeConfig,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  registerConfigWriteListener,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import {
  ensureControlUiAssetsBuilt,
  isPackageProvenControlUiRootSync,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { logAcceptedEnvOption } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
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
import { resolveBundledPluginInstallCommandHint } from "../plugins/bundled-sources.js";
import {
  resolveConfiguredDeferredChannelPluginIds,
  resolveGatewayStartupPluginIds,
} from "../plugins/channel-plugin-ids.js";
import { getGlobalHookRunner, runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
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
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  resolveCommandSecretsFromActiveRuntimeSnapshot,
} from "../secrets/runtime.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  getInspectableTaskRegistrySummary,
  startTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import { runSetupWizard } from "../wizard/setup.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import type { ControlUiRootState } from "./control-ui.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { startGatewayModelPricingRefresh } from "./model-pricing-cache.js";
import { NodeRegistry } from "./node-registry.js";
import { createChannelManager } from "./server-channels.js";
import {
  createAgentEventHandler,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { createGatewayCloseHandler } from "./server-close.js";
import { buildGatewayCronService } from "./server-cron.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { safeParseJson } from "./server-methods/nodes.helpers.js";
import { createPluginApprovalHandlers } from "./server-methods/plugin-approval.js";
import { createSecretsHandlers } from "./server-methods/secrets.js";
import { hasConnectedMobileNode } from "./server-mobile-nodes.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import {
  loadGatewayStartupPlugins,
  reloadDeferredGatewayPlugins,
} from "./server-plugin-bootstrap.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import { logGatewayStartup } from "./server-startup-log.js";
import { runStartupMatrixMigration } from "./server-startup-matrix-migration.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";
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
import { resolveSessionKeyForTranscriptFile } from "./session-transcript-key.js";
import {
  attachOpenClawTranscriptMeta,
  loadGatewaySessionRow,
  loadSessionEntry,
  readSessionMessages,
} from "./session-utils.js";
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

function assertValidGatewayStartupConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  options: { includeDoctorHint?: boolean } = {},
): void {
  if (snapshot.valid) {
    return;
  }
  const issues =
    snapshot.issues.length > 0
      ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
      : "Unknown validation issue.";
  const doctorHint = options.includeDoctorHint
    ? `\nRun "${formatCliCommand("openclaw doctor")}" to repair, then retry.`
    : "";
  throw new Error(`Invalid config at ${snapshot.path}.\n${issues}${doctorHint}`);
}

async function prepareGatewayStartupConfig(params: {
  configSnapshot: ConfigFileSnapshot;
  // Keep startup auth/runtime behavior aligned with loadConfig(), which applies
  // runtime overrides beyond the raw on-disk snapshot.
  runtimeConfig: OpenClawConfig;
  authOverride?: GatewayServerOptions["auth"];
  tailscaleOverride?: GatewayServerOptions["tailscale"];
  activateRuntimeSecrets: (
    config: OpenClawConfig,
    options: { reason: "startup"; activate: boolean },
  ) => Promise<{ config: OpenClawConfig }>;
}): Promise<Awaited<ReturnType<typeof ensureGatewayStartupAuth>>> {
  assertValidGatewayStartupConfigSnapshot(params.configSnapshot);

  // Fail fast before startup auth persists anything if required refs are unresolved.
  const startupPreflightConfig = applyGatewayAuthOverridesForStartupPreflight(
    params.runtimeConfig,
    {
      auth: params.authOverride,
      tailscale: params.tailscaleOverride,
    },
  );
  await params.activateRuntimeSecrets(startupPreflightConfig, {
    reason: "startup",
    activate: false,
  });

  const authBootstrap = await ensureGatewayStartupAuth({
    cfg: params.runtimeConfig,
    env: process.env,
    authOverride: params.authOverride,
    tailscaleOverride: params.tailscaleOverride,
    persist: true,
    baseHash: params.configSnapshot.hash,
  });
  const runtimeStartupConfig = applyGatewayAuthOverridesForStartupPreflight(authBootstrap.cfg, {
    auth: params.authOverride,
    tailscale: params.tailscaleOverride,
  });
  const activatedConfig = (
    await params.activateRuntimeSecrets(runtimeStartupConfig, {
      reason: "startup",
      activate: true,
    })
  ).config;
  return {
    ...authBootstrap,
    cfg: activatedConfig,
  };
}

export type GatewayServer = {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
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

  let configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      throw new Error(
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacyConfig(configSnapshot.parsed);
    if (!migrated) {
      log.warn(
        "gateway: legacy config entries detected but no auto-migration changes were produced; continuing with validation.",
      );
    } else {
      await writeConfigFile(migrated);
      if (changes.length > 0) {
        log.info(
          `gateway: migrated legacy config entries:\n${changes
            .map((entry) => `- ${entry}`)
            .join("\n")}`,
        );
      }
    }
  }

  configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.exists) {
    assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
  }

  const autoEnable = applyPluginAutoEnable({ config: configSnapshot.config, env: process.env });
  if (autoEnable.changes.length > 0) {
    try {
      await writeConfigFile(autoEnable.config);
      configSnapshot = await readConfigFileSnapshot();
      assertValidGatewayStartupConfigSnapshot(configSnapshot);
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
          logGatewayAuthSurfaceDiagnostics(prepared);
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

  let cfgAtStart: OpenClawConfig;
  let startupInternalWriteHash: string | null = null;
  const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
  const authBootstrap = await prepareGatewayStartupConfig({
    configSnapshot,
    runtimeConfig: startupRuntimeConfig,
    authOverride: opts.auth,
    tailscaleOverride: opts.tailscale,
    activateRuntimeSecrets,
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
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat(undefined, { getConfig: getRuntimeConfig });
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  setPreRestartDeferralCheck(
    () =>
      getTotalQueueSize() +
      getTotalPendingReplies() +
      getActiveEmbeddedRunCount() +
      getInspectableTaskRegistrySummary().active,
  );
  // Unconditional startup migration: seed gateway.controlUi.allowedOrigins for existing
  // non-loopback installs that upgraded to v2026.2.26+ without required origins.
  const controlUiSeed = await maybeSeedControlUiAllowedOriginsAtStartup({
    config: cfgAtStart,
    writeConfig: writeConfigFile,
    log,
  });
  cfgAtStart = controlUiSeed.config;
  if (authBootstrap.persistedGeneratedToken || controlUiSeed.persistedAllowedOriginsSeed) {
    const startupSnapshot = await readConfigFileSnapshot();
    startupInternalWriteHash = startupSnapshot.hash ?? null;
  }
  await runStartupMatrixMigration({
    cfg: cfgAtStart,
    env: process.env,
    log,
  });
  await runStartupSessionMigration({
    cfg: cfgAtStart,
    env: process.env,
    log,
  });
  const matrixInstallPathIssue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfgAtStart.plugins?.installs?.matrix,
  });
  if (matrixInstallPathIssue) {
    const lines = formatPluginInstallPathIssue({
      issue: matrixInstallPathIssue,
      pluginLabel: "Matrix",
      defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
      repoInstallCommand: resolveBundledPluginInstallCommandHint({
        pluginId: "matrix",
        workspaceDir: process.cwd(),
      }),
      formatCommand: formatCliCommand,
    });
    log.warn(
      `gateway: matrix install path warning:\n${lines.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  initSubagentRegistry();
  const gatewayPluginConfigAtStart = applyPluginAutoEnable({
    config: cfgAtStart,
    env: process.env,
  }).config;
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfigAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfigAtStart, defaultAgentId);
  const deferredConfiguredChannelPluginIds = minimalTestGateway
    ? []
    : resolveConfiguredDeferredChannelPluginIds({
        config: gatewayPluginConfigAtStart,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
      });
  const startupPluginIds = minimalTestGateway
    ? []
    : resolveGatewayStartupPluginIds({
        config: gatewayPluginConfigAtStart,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
      });
  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry = emptyPluginRegistry;
  let baseGatewayMethods = baseMethods;
  if (!minimalTestGateway) {
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = loadGatewayStartupPlugins({
      cfg: gatewayPluginConfigAtStart,
      workspaceDir: defaultWorkspaceDir,
      log,
      coreGatewayHandlers,
      baseMethods,
      pluginIds: startupPluginIds,
      preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0,
    }));
  } else {
    setActivePluginRegistry(emptyPluginRegistry);
  }
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as unknown as Record<ChannelId, RuntimeEnv>;
  const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
  const gatewayMethods = Array.from(new Set([...baseGatewayMethods, ...channelMethods]));
  let pluginServicesReady: Promise<PluginServicesHandle | null> = Promise.resolve(null);
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
      ? {
          kind: isPackageProvenControlUiRootSync(resolvedRoot, {
            moduleUrl: import.meta.url,
            argv1: process.argv[1],
            cwd: process.cwd(),
          })
            ? "bundled"
            : "resolved",
          path: resolvedRoot,
        }
      : { kind: "missing" };
  }

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
    loadConfig: () =>
      applyPluginAutoEnable({
        config: loadConfig(),
        env: process.env,
      }).config,
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
    preauthConnectionBudget,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    chatDeltaLastBroadcastLen,
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
    pinChannelRegistry: !minimalTestGateway,
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
  const noopInterval = () => setInterval(() => {}, 1 << 30);
  let tickInterval = noopInterval();
  let healthInterval = noopInterval();
  let dedupeCleanup = noopInterval();
  let mediaCleanup: ReturnType<typeof setInterval> | null = null;
  let heartbeatRunner: HeartbeatRunner = {
    stop: () => {},
    updateConfig: () => {},
  };
  let stopGatewayUpdateCheck = () => {};
  let tailscaleCleanup: (() => Promise<void>) | null = null;
  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const skillsRefreshDelayMs = 30_000;
  let skillsChangeUnsub = () => {};
  let channelHealthMonitor: ReturnType<typeof startChannelHealthMonitor> | null = null;
  let stopModelPricingRefresh = () => {};
  let configReloader: { stop: () => Promise<void> } = { stop: async () => {} };
  const closeOnStartupFailure = async () => {
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
    stopModelPricingRefresh();
    channelHealthMonitor?.stop();
    clearSecretsRuntimeSnapshot();
    await createGatewayCloseHandler({
      bonjourStop,
      tailscaleCleanup,
      canvasHost,
      canvasHostServer,
      releasePluginRouteRegistry,
      stopChannel,
      pluginServicesReady,
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
      transcriptUnsub,
      lifecycleUnsub,
      chatRunState,
      clients,
      configReloader,
      wss,
      httpServer,
      httpServers,
    })({ reason: "gateway startup failed" });
  };
  const nodeRegistry = new NodeRegistry();
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
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
  let agentUnsub: (() => void) | null = null;
  let heartbeatUnsub: (() => void) | null = null;
  let transcriptUnsub: (() => void) | null = null;
  let lifecycleUnsub: (() => void) | null = null;
  try {
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
    skillsChangeUnsub = minimalTestGateway
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

    if (!minimalTestGateway) {
      startTaskRegistryMaintenance();
      ({ tickInterval, healthInterval, dedupeCleanup, mediaCleanup } =
        startGatewayMaintenanceTimers({
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
          chatDeltaLastBroadcastLen,
          removeChatRun,
          agentRunSeq,
          nodeSendToSession,
          ...(typeof cfgAtStart.media?.ttlHours === "number"
            ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) }
            : {}),
        }));
    }

    agentUnsub = minimalTestGateway
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
            sessionEventSubscribers,
          }),
        );

    heartbeatUnsub = minimalTestGateway
      ? null
      : onHeartbeatEvent((evt) => {
          broadcast("heartbeat", evt, { dropIfSlow: true });
        });

    transcriptUnsub = minimalTestGateway
      ? null
      : onSessionTranscriptUpdate((update) => {
          const sessionKey =
            update.sessionKey ?? resolveSessionKeyForTranscriptFile(update.sessionFile);
          if (!sessionKey || update.message === undefined) {
            return;
          }
          const connIds = new Set<string>();
          for (const connId of sessionEventSubscribers.getAll()) {
            connIds.add(connId);
          }
          for (const connId of sessionMessageSubscribers.get(sessionKey)) {
            connIds.add(connId);
          }
          if (connIds.size === 0) {
            return;
          }
          const { entry, storePath } = loadSessionEntry(sessionKey);
          const messageSeq = entry?.sessionId
            ? readSessionMessages(entry.sessionId, storePath, entry.sessionFile).length
            : undefined;
          const sessionRow = loadGatewaySessionRow(sessionKey);
          const sessionSnapshot = sessionRow
            ? {
                session: sessionRow,
                updatedAt: sessionRow.updatedAt ?? undefined,
                sessionId: sessionRow.sessionId,
                kind: sessionRow.kind,
                channel: sessionRow.channel,
                subject: sessionRow.subject,
                groupChannel: sessionRow.groupChannel,
                space: sessionRow.space,
                chatType: sessionRow.chatType,
                origin: sessionRow.origin,
                spawnedBy: sessionRow.spawnedBy,
                spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
                forkedFromParent: sessionRow.forkedFromParent,
                spawnDepth: sessionRow.spawnDepth,
                subagentRole: sessionRow.subagentRole,
                subagentControlScope: sessionRow.subagentControlScope,
                label: sessionRow.label,
                displayName: sessionRow.displayName,
                deliveryContext: sessionRow.deliveryContext,
                parentSessionKey: sessionRow.parentSessionKey,
                childSessions: sessionRow.childSessions,
                thinkingLevel: sessionRow.thinkingLevel,
                fastMode: sessionRow.fastMode,
                verboseLevel: sessionRow.verboseLevel,
                reasoningLevel: sessionRow.reasoningLevel,
                elevatedLevel: sessionRow.elevatedLevel,
                sendPolicy: sessionRow.sendPolicy,
                systemSent: sessionRow.systemSent,
                abortedLastRun: sessionRow.abortedLastRun,
                inputTokens: sessionRow.inputTokens,
                outputTokens: sessionRow.outputTokens,
                lastChannel: sessionRow.lastChannel,
                lastTo: sessionRow.lastTo,
                lastAccountId: sessionRow.lastAccountId,
                lastThreadId: sessionRow.lastThreadId,
                totalTokens: sessionRow.totalTokens,
                totalTokensFresh: sessionRow.totalTokensFresh,
                contextTokens: sessionRow.contextTokens,
                estimatedCostUsd: sessionRow.estimatedCostUsd,
                responseUsage: sessionRow.responseUsage,
                modelProvider: sessionRow.modelProvider,
                model: sessionRow.model,
                status: sessionRow.status,
                startedAt: sessionRow.startedAt,
                endedAt: sessionRow.endedAt,
                runtimeMs: sessionRow.runtimeMs,
              }
            : {};
          const message = attachOpenClawTranscriptMeta(update.message, {
            ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
            ...(typeof messageSeq === "number" ? { seq: messageSeq } : {}),
          });
          broadcastToConnIds(
            "session.message",
            {
              sessionKey,
              message,
              ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
              ...(typeof messageSeq === "number" ? { messageSeq } : {}),
              ...sessionSnapshot,
            },
            connIds,
            { dropIfSlow: true },
          );

          const sessionEventConnIds = sessionEventSubscribers.getAll();
          if (sessionEventConnIds.size > 0) {
            broadcastToConnIds(
              "sessions.changed",
              {
                sessionKey,
                phase: "message",
                ts: Date.now(),
                ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
                ...(typeof messageSeq === "number" ? { messageSeq } : {}),
                ...sessionSnapshot,
              },
              sessionEventConnIds,
              { dropIfSlow: true },
            );
          }
        });

    lifecycleUnsub = minimalTestGateway
      ? null
      : onSessionLifecycleEvent((event) => {
          const connIds = sessionEventSubscribers.getAll();
          if (connIds.size === 0) {
            return;
          }
          const sessionRow = loadGatewaySessionRow(event.sessionKey);
          broadcastToConnIds(
            "sessions.changed",
            {
              sessionKey: event.sessionKey,
              reason: event.reason,
              parentSessionKey: event.parentSessionKey,
              label: event.label,
              displayName: event.displayName,
              ts: Date.now(),
              ...(sessionRow
                ? {
                    updatedAt: sessionRow.updatedAt ?? undefined,
                    sessionId: sessionRow.sessionId,
                    kind: sessionRow.kind,
                    channel: sessionRow.channel,
                    subject: sessionRow.subject,
                    groupChannel: sessionRow.groupChannel,
                    space: sessionRow.space,
                    chatType: sessionRow.chatType,
                    origin: sessionRow.origin,
                    spawnedBy: sessionRow.spawnedBy,
                    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
                    forkedFromParent: sessionRow.forkedFromParent,
                    spawnDepth: sessionRow.spawnDepth,
                    subagentRole: sessionRow.subagentRole,
                    subagentControlScope: sessionRow.subagentControlScope,
                    label: event.label ?? sessionRow.label,
                    displayName: event.displayName ?? sessionRow.displayName,
                    deliveryContext: sessionRow.deliveryContext,
                    parentSessionKey: event.parentSessionKey ?? sessionRow.parentSessionKey,
                    childSessions: sessionRow.childSessions,
                    thinkingLevel: sessionRow.thinkingLevel,
                    fastMode: sessionRow.fastMode,
                    verboseLevel: sessionRow.verboseLevel,
                    reasoningLevel: sessionRow.reasoningLevel,
                    elevatedLevel: sessionRow.elevatedLevel,
                    sendPolicy: sessionRow.sendPolicy,
                    systemSent: sessionRow.systemSent,
                    abortedLastRun: sessionRow.abortedLastRun,
                    inputTokens: sessionRow.inputTokens,
                    outputTokens: sessionRow.outputTokens,
                    lastChannel: sessionRow.lastChannel,
                    lastTo: sessionRow.lastTo,
                    lastAccountId: sessionRow.lastAccountId,
                    lastThreadId: sessionRow.lastThreadId,
                    totalTokens: sessionRow.totalTokens,
                    totalTokensFresh: sessionRow.totalTokensFresh,
                    contextTokens: sessionRow.contextTokens,
                    estimatedCostUsd: sessionRow.estimatedCostUsd,
                    responseUsage: sessionRow.responseUsage,
                    modelProvider: sessionRow.modelProvider,
                    model: sessionRow.model,
                    status: sessionRow.status,
                    startedAt: sessionRow.startedAt,
                    endedAt: sessionRow.endedAt,
                    runtimeMs: sessionRow.runtimeMs,
                  }
                : {}),
            },
            connIds,
            { dropIfSlow: true },
          );
        });

    if (!minimalTestGateway) {
      heartbeatRunner = startHeartbeatRunner({ cfg: cfgAtStart });
    }

    const healthCheckMinutes = cfgAtStart.gateway?.channelHealthCheckMinutes;
    const healthCheckDisabled = healthCheckMinutes === 0;
    const staleEventThresholdMinutes = cfgAtStart.gateway?.channelStaleEventThresholdMinutes;
    const maxRestartsPerHour = cfgAtStart.gateway?.channelMaxRestartsPerHour;
    channelHealthMonitor = healthCheckDisabled
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

    stopModelPricingRefresh =
      !minimalTestGateway && process.env.VITEST !== "1"
        ? startGatewayModelPricingRefresh({ config: cfgAtStart })
        : () => {};

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
    const pluginApprovalManager = new ExecApprovalManager<
      import("../infra/plugin-approvals.js").PluginApprovalRequestPayload
    >();
    const pluginApprovalHandlers = createPluginApprovalHandlers(pluginApprovalManager, {
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
      pluginApprovalManager,
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
      hasExecApprovalClients: (excludeConnId?: string) => {
        for (const gatewayClient of clients) {
          if (excludeConnId && gatewayClient.connId === excludeConnId) {
            continue;
          }
          const scopes = Array.isArray(gatewayClient.connect.scopes)
            ? gatewayClient.connect.scopes
            : [];
          if (scopes.includes("operator.admin") || scopes.includes("operator.approvals")) {
            return true;
          }
        }
        return false;
      },
      disconnectClientsForDevice: (deviceId: string, opts?: { role?: string }) => {
        for (const gatewayClient of clients) {
          if (gatewayClient.connect.device?.id !== deviceId) {
            continue;
          }
          if (opts?.role && gatewayClient.connect.role !== opts.role) {
            continue;
          }
          try {
            gatewayClient.socket.close(4001, "device removed");
          } catch {
            /* ignore */
          }
        }
      },
      nodeRegistry,
      agentRunSeq,
      chatAbortControllers,
      chatAbortedRuns: chatRunState.abortedRuns,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
      addChatRun,
      removeChatRun,
      subscribeSessionEvents: sessionEventSubscribers.subscribe,
      unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe,
      subscribeSessionMessageEvents: sessionMessageSubscribers.subscribe,
      unsubscribeSessionMessageEvents: sessionMessageSubscribers.unsubscribe,
      unsubscribeAllSessionEvents: (connId: string) => {
        sessionEventSubscribers.unsubscribe(connId);
        sessionMessageSubscribers.unsubscribeAll(connId);
      },
      getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
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

    // Register a lazy fallback for plugin subagent dispatch in non-WS paths
    // (Telegram polling, WhatsApp, etc.) so later runtime swaps can expose the
    // current gateway context without relying on a startup snapshot.
    setFallbackGatewayContextResolver(() => gatewayRequestContext);

    attachGatewayWsHandlers({
      wss,
      clients,
      preauthConnectionBudget,
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
        ...pluginApprovalHandlers,
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
    stopGatewayUpdateCheck = minimalTestGateway
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
    tailscaleCleanup = minimalTestGateway
      ? null
      : await startGatewayTailscaleExposure({
          tailscaleMode,
          resetOnExit: tailscaleConfig.resetOnExit,
          port,
          controlUiBasePath,
          logTailscale,
        });

    if (!minimalTestGateway) {
      if (deferredConfiguredChannelPluginIds.length > 0) {
        ({ pluginRegistry } = reloadDeferredGatewayPlugins({
          cfg: gatewayPluginConfigAtStart,
          workspaceDir: defaultWorkspaceDir,
          log,
          coreGatewayHandlers,
          baseMethods,
          pluginIds: startupPluginIds,
          logDiagnostics: false,
        }));
      }
      ({ pluginServicesReady } = await startGatewaySidecars({
        cfg: gatewayPluginConfigAtStart,
        pluginRegistry,
        defaultWorkspaceDir,
        deps,
        startChannels,
        log,
        logHooks,
        logChannels,
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

    configReloader = minimalTestGateway
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
              channelHealthMonitor,
            }),
            setState: (nextState) => {
              hooksConfig = nextState.hooksConfig;
              hookClientIpConfig = nextState.hookClientIpConfig;
              heartbeatRunner = nextState.heartbeatRunner;
              cronState = nextState.cronState;
              cron = cronState.cron;
              cronStorePath = cronState.storePath;
              channelHealthMonitor = nextState.channelHealthMonitor;
            },
            startChannel,
            stopChannel,
            logHooks,
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

          return startGatewayConfigReloader({
            initialConfig: cfgAtStart,
            initialInternalWriteHash: startupInternalWriteHash,
            readSnapshot: readConfigFileSnapshot,
            subscribeToWrites: registerConfigWriteListener,
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
              await activateRuntimeSecrets(nextConfig, {
                reason: "restart-check",
                activate: false,
              });
              requestGatewayRestart(plan, nextConfig);
            },
            log: {
              info: (msg) => logReload.info(msg),
              warn: (msg) => logReload.warn(msg),
              error: (msg) => logReload.error(msg),
            },
            watchPath: configSnapshot.path,
          });
        })();
  } catch (err) {
    await closeOnStartupFailure();
    throw err;
  }

  const close = createGatewayCloseHandler({
    bonjourStop,
    tailscaleCleanup,
    canvasHost,
    canvasHostServer,
    releasePluginRouteRegistry,
    stopChannel,
    pluginServicesReady,
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
    transcriptUnsub,
    lifecycleUnsub,
    chatRunState,
    clients,
    configReloader,
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
      stopModelPricingRefresh();
      channelHealthMonitor?.stop();
      clearSecretsRuntimeSnapshot();
      await close(opts);
    },
  };
}
