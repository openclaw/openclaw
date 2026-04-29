/**
 * Gateway 服务器实现模块
 * 负责启动和管理 Gateway 服务器的核心逻辑
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import {
  getRuntimeConfig,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshot,
  recoverConfigFromLastKnownGood,
  registerConfigWriteListener,
} from "../config/io.js";
import { replaceConfigFile } from "../config/mutate.js";
import { isNixMode } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext } from "../infra/agent-events.js";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { isTruthyEnvValue, isVitestRuntimeEnv, logAcceptedEnvOption } from "../infra/env.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { VoiceWakeRoutingConfig } from "../infra/voicewake-routing.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { getActiveBundledRuntimeDepsInstallCount } from "../plugins/bundled-runtime-deps-activity.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  getInspectableTaskRegistrySummary,
  stopTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { resolveGatewayAuth } from "./auth.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createChannelManager } from "./server-channels.js";
import { resolveGatewayControlUiRootState } from "./server-control-ui-root.js";
import { buildGatewayCronService } from "./server-cron.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayServerLiveState, type GatewayServerLiveState } from "./server-live-state.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { bootstrapGatewayNetworkRuntime } from "./server-network-runtime.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import {
  activateGatewayScheduledServices,
  startGatewayRuntimeServices,
} from "./server-runtime-services.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  getRequiredSharedGatewaySessionGeneration,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import {
  createRuntimeSecretsActivator,
  loadGatewayStartupConfigSnapshot,
  prepareGatewayStartupConfig,
} from "./server-startup-config.js";
import { prepareGatewayPluginBootstrap } from "./server-startup-plugins.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./server-startup-unavailable-methods.js";
import { startGatewayEarlyRuntime, startGatewayPostAttachRuntime } from "./server-startup.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { attachGatewayWsHandlers } from "./server-ws-runtime.js";
import { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";
import { createReadinessChecker } from "./server/readiness.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

// 导出模型目录缓存重置函数（供测试使用）
export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

// 确保 OpenClaw CLI 在 PATH 中可用
ensureOpenClawCliOnPath();

// 媒体清理最大 TTL 常量：7 天
const MAX_MEDIA_TTL_HOURS = 24 * 7;

/**
 * 解析媒体清理 TTL 毫秒值
 * 将小时数转换为毫秒，并确保在有效范围内
 * @param ttlHoursRaw - 原始 TTL 小时数
 * @returns 有效的 TTL 毫秒值
 */
function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  // 将 TTL 限制在 1 到 MAX_MEDIA_TTL_HOURS 之间
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  // 转换为毫秒：小时 * 60分钟 * 60秒 * 1000毫秒
  const ttlMs = ttlHours * 60 * 60_000;
  // 验证转换后的值是有限且安全的整数
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

// 创建主日志记录器实例
const log = createSubsystemLogger("gateway");
// 为各个子系统创建子日志记录器
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");

// 缓存通道运行时的 Promise，避免重复加载
let cachedChannelRuntimePromise: Promise<PluginRuntime["channel"]> | null = null;
// 缓存启动时通道运行时的 Promise
let cachedStartupChannelRuntimePromise: Promise<ChannelRuntimeSurface> | null = null;

/**
 * 获取通道运行时实例
 * 使用单例模式缓存 Promise，首次调用时懒加载
 * @returns 通道运行时的 Promise
 */
function getChannelRuntime() {
  // 缓存逻辑：仅在首次调用时创建 Promise
  cachedChannelRuntimePromise ??= import("../plugins/runtime/runtime-channel.js").then(
    ({ createRuntimeChannel }) => createRuntimeChannel(),
  );
  return cachedChannelRuntimePromise;
}

/**
 * 获取启动时的通道运行时实例
 * 用于启动早期阶段的通道上下文
 * @returns 通道运行时表面的 Promise
 */
function getStartupChannelRuntime() {
  cachedStartupChannelRuntimePromise ??=
    import("../plugins/runtime/channel-runtime-contexts.js").then(
      ({ createChannelRuntimeContextRegistry }) => ({
        runtimeContexts: createChannelRuntimeContextRegistry(),
      }),
    );
  return cachedStartupChannelRuntimePromise;
}

/**
 * 按需关闭 MCP 回环服务器
 * 在网关关闭时清理 MCP 相关资源
 */
async function closeMcpLoopbackServerOnDemand(): Promise<void> {
  const { closeMcpLoopbackServer } = await import("./mcp-http.js");
  await closeMcpLoopbackServer();
}

// 缓存网关关闭模块的 Promise
let gatewayCloseModulePromise: Promise<typeof import("./server-close.js")> | null = null;

/**
 * 加载网关关闭模块
 * 使用 Promise 缓存避免重复加载
 * @returns 关闭模块的 Promise
 */
function loadGatewayCloseModule(): Promise<typeof import("./server-close.js")> {
  gatewayCloseModulePromise ??= import("./server-close.js");
  return gatewayCloseModulePromise;
}

// 为各个功能模块创建子日志记录器
const logHealth = log.child("health");        // 健康检查日志
const logCron = log.child("cron");            // 定时任务日志
const logReload = log.child("reload");        // 配置重载日志
const logHooks = log.child("hooks");          // 钩子日志
const logPlugins = log.child("plugins");      // 插件日志
const logWsControl = log.child("ws");        // WebSocket 控制日志
const logSecrets = log.child("secrets");     // 密钥日志
// 为日志器创建运行时环境
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

/**
 * 创建网关启动追踪器
 * 用于记录启动过程中各阶段的耗时
 * @returns 包含 mark、detail、measure 方法的追踪器对象
 */
function createGatewayStartupTrace() {
  // 检查是否启用启动追踪
  const enabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
  // 如果启用，创建事件循环延迟监视器（10ms 分辨率）
  const eventLoopDelay = enabled ? monitorEventLoopDelay({ resolution: 10 }) : undefined;
  eventLoopDelay?.enable();
  // 记录启动开始时间
  const started = performance.now();
  let last = started;
  // 格式化指标值为字符串
  const formatMetric = (key: string, value: number | string) =>
    `${key}=${typeof value === "number" ? value.toFixed(1) : value}`;
  // 读取事件循环最大延迟（毫秒）
  const readEventLoopMaxMs = () => {
    if (!eventLoopDelay) {
      return 0;
    }
    const maxMs = eventLoopDelay.max / 1_000_000; // 纳秒转毫秒
    eventLoopDelay.reset();
    return maxMs;
  };
  // 发送追踪日志
  const emit = (
    name: string,                              // 事件名称
    durationMs: number,                        // 当前步骤耗时
    totalMs: number,                           // 总耗时
    extras: ReadonlyArray<readonly [string, number | string]> = [], // 额外指标
  ) => {
    if (enabled) {
      const metrics = [
        `eventLoopMax=${readEventLoopMaxMs().toFixed(1)}ms`,
        ...extras.map(([key, value]) => formatMetric(key, value)),
      ].join(" ");
      log.info(
        `startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms ${metrics}`,
      );
    }
  };
  // 返回追踪器接口
  return {
    /**
     * 标记一个追踪点
     * @param name - 追踪点名称
     */
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
      // "ready" 标记时禁用事件循环延迟监视
      if (name === "ready") {
        eventLoopDelay?.disable();
      }
    },
    /**
     * 记录详细指标
     * @param name - 指标名称
     * @param metrics - 指标键值对数组
     */
    detail(name: string, metrics: ReadonlyArray<readonly [string, number | string]>) {
      if (!enabled) {
        return;
      }
      log.info(
        `startup trace: ${name} ${metrics.map(([key, value]) => formatMetric(key, value)).join(" ")}`,
      );
    },
    /**
     * 测量异步操作的耗时
     * @param name - 操作名称
     * @param run - 要测量的异步函数
     * @returns 函数的返回结果
     */
    async measure<T>(name: string, run: () => Promise<T> | T): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

// 认证限速器配置类型别名
type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

/**
 * 创建网关认证限速器
 * 根据配置创建通用限速器和浏览器专用限速器
 * @param rateLimitConfig - 限速器配置
 * @returns 包含通用限速器和浏览器限速器的对象
 */
function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  // 创建通用限速器（如果配置存在）
  const rateLimiter = rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : undefined;
  // 浏览器来源的 WS 认证始终不使用 loopback 豁免
  const browserRateLimiter = createAuthRateLimiter({
    ...rateLimitConfig,
    exemptLoopback: false,
  });
  return { rateLimiter, browserRateLimiter };
}

/**
 * Gateway 服务器实例类型定义
 * 包含关闭服务器的方法
 */
export type GatewayServer = {
  /**
   * 关闭网关服务器
   * @param opts - 关闭选项
   * @param opts.reason - 关闭原因
   * @param opts.restartExpectedMs - 预期重启时间（毫秒）
   */
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

/**
 * Gateway 服务器启动选项类型
 */
export type GatewayServerOptions = {
  /**
   * 网关 WebSocket/HTTP 服务器的绑定地址策略
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: 仅绑定到 Tailscale IPv4 地址 (100.64.0.0/10)
   * - auto: 优先 loopback，否则使用 LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * 绑定主机的高级覆盖，绕过绑定地址解析
   * 仅在确实需要特定地址时使用
   */
  host?: string;
  /**
   * 如果为 false，则不提供浏览器控制 UI
   * 默认值：配置中的 gateway.controlUi.enabled（不存在时为 true）
   */
  controlUiEnabled?: boolean;
  /**
   * 如果为 false，则不提供 POST /v1/chat/completions
   * 默认值：配置中的 gateway.http.endpoints.chatCompletions.enabled（不存在时为 false）
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * 如果为 false，则不提供 POST /v1/responses (OpenResponses API)
   * 默认值：配置中的 gateway.http.endpoints.responses.enabled（不存在时为 false）
   */
  openResponsesEnabled?: boolean;
  /**
   * 覆盖网关认证配置（与配置合并）
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * 覆盖网关 Tailscale 暴露配置（与配置合并）
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * 测试专用：即使 NODE_ENV/VITEST 会禁用也允许画布主机启动
   */
  allowCanvasHostInTests?: boolean;
  /**
   * 测试专用：覆盖设置向导运行器
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  /**
   * 让后监听 sidecar（通道、插件服务）在后台完成
   * 默认为 false，以便网关启动等待 sidecar 就绪
   */
  deferStartupSidecars?: boolean;
  /**
   * 用于简洁就绪日志的可选启动时间戳
   */
  startupStartedAt?: number;
};

// 设置向导运行器类型别名
type SetupWizardRunner = NonNullable<GatewayServerOptions["wizardRunner"]>;

/**
 * 默认设置向导运行器
 * 动态导入并调用设置向导模块
 */
const runDefaultSetupWizard: SetupWizardRunner = async (...args) => {
  const { runSetupWizard } = await import("../wizard/setup.js");
  return runSetupWizard(...args);
};

/**
 * 启动 Gateway 服务器
 * 初始化所有必要的组件并返回服务器实例
 * @param port - 服务器端口号，默认为 18789
 * @param opts - 服务器启动选项
 * @returns Promise<GatewayServer> - 服务器实例
 */
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  // 引导网络运行时环境
  bootstrapGatewayNetworkRuntime();

  // 检测是否为最小化测试网关
  const minimalTestGateway =
    isVitestRuntimeEnv() && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";

  // 确保所有默认端口派生（浏览器/画布）使用实际运行时端口
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  // 记录原始流日志选项
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });
  // 创建启动追踪器
  const startupTrace = createGatewayStartupTrace();

  // 测量配置快照加载耗时
  const startupConfigLoad = await startupTrace.measure("config.snapshot", () =>
    loadGatewayStartupConfigSnapshot({
      minimalTestGateway,
      log,
      measure: (name, run) => startupTrace.measure(name, run),
    }),
  );
  const configSnapshot = startupConfigLoad.snapshot;

  // 创建密钥状态事件发射器
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
  // 创建运行时密钥激活器
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    logSecrets,
    emitStateEvent: emitSecretsStateEvent,
  });

  let cfgAtStart: OpenClawConfig;
  let startupInternalWriteHash: string | null = null;
  let startupLastGoodSnapshot = configSnapshot;
  const startupActivationSourceConfig = configSnapshot.sourceConfig;
  // 应用配置覆盖
  const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
  // 准备网关启动配置并测量耗时
  const authBootstrap = await startupTrace.measure("config.auth", () =>
    prepareGatewayStartupConfig({
      configSnapshot,
      authOverride: opts.auth,
      tailscaleOverride: opts.tailscale,
      activateRuntimeSecrets,
      persistStartupAuth: startupConfigLoad.degradedProviderApi !== true,
    }),
  );
  cfgAtStart = authBootstrap.cfg;
  // 如果生成了新令牌，记录日志
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
  // 设置诊断功能
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat(undefined, { getConfig: getRuntimeConfig });
  }
  // 设置 SIGUSR1 重启策略
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  // 设置重启延迟检查
  setPreRestartDeferralCheck(
    () =>
      getTotalQueueSize() +
      getTotalPendingReplies() +
      getActiveEmbeddedRunCount() +
      getActiveBundledRuntimeDepsInstallCount() +
      getInspectableTaskRegistrySummary().active,
  );
  // 无条件启动迁移：为升级到 v2026.2.26+ 但没有必需 origins 的现有非循环访问安装种子化 gateway.controlUi.allowedOrigins
  const controlUiSeed = minimalTestGateway
    ? { config: cfgAtStart, persistedAllowedOriginsSeed: false }
    : await startupTrace.measure("control-ui.seed", () =>
        maybeSeedControlUiAllowedOriginsAtStartup({
          config: cfgAtStart,
          writeConfig: async (nextConfig) => {
            await replaceConfigFile({
              nextConfig,
              afterWrite: { mode: "auto" },
            });
          },
          log,
          runtimeBind: opts.bind,
          runtimePort: port,
        }),
      );
  cfgAtStart = controlUiSeed.config;
  // 仅在启动写入后（插件自动启用、认证令牌生成、控制 UI origin 种子化）捕获最终配置哈希
  // 以便配置重载器可以抑制自己的持久化事件而无需每次启动时重新读取配置
  if (
    startupConfigLoad.wroteConfig ||
    authBootstrap.persistedGeneratedToken ||
    controlUiSeed.persistedAllowedOriginsSeed
  ) {
    const startupSnapshot = await startupTrace.measure("config.final-snapshot", () =>
      readConfigFileSnapshot(),
    );
    startupInternalWriteHash = startupSnapshot.hash ?? null;
    startupLastGoodSnapshot = startupSnapshot;
  }
  // 准备插件引导并测量耗时
  const pluginBootstrap = await startupTrace.measure("plugins.bootstrap", () =>
    prepareGatewayPluginBootstrap({
      cfgAtStart,
      activationSourceConfig: startupActivationSourceConfig,
      startupRuntimeConfig,
      pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot,
      minimalTestGateway,
      log,
    }),
  );
  const {
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    pluginLookUpTable,
    baseMethods,
  } = pluginBootstrap;
  // 设置当前插件元数据快照
  setCurrentPluginMetadataSnapshot(pluginLookUpTable, { config: gatewayPluginConfigAtStart });
  // 记录插件查找表指标
  if (pluginLookUpTable) {
    const metrics = pluginLookUpTable.metrics;
    startupTrace.detail("plugins.lookup-table", [
      ["registrySnapshotMs", metrics.registrySnapshotMs],
      ["manifestRegistryMs", metrics.manifestRegistryMs],
      ["startupPlanMs", metrics.startupPlanMs],
      ["ownerMapsMs", metrics.ownerMapsMs],
      ["totalMs", metrics.totalMs],
      ["indexPlugins", String(metrics.indexPluginCount)],
      ["manifestPlugins", String(metrics.manifestPluginCount)],
      ["startupPlugins", String(metrics.startupPluginCount)],
      ["deferredChannelPlugins", String(metrics.deferredChannelPluginCount)],
    ]);
  }
  let { pluginRegistry, baseGatewayMethods } = pluginBootstrap;
  // 为每个通道插件创建日志记录器
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  // 为通道创建运行时环境
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as unknown as Record<ChannelId, RuntimeEnv>;
  // 列出所有活动的网关方法
  const listActiveGatewayMethods = (nextBaseGatewayMethods: string[]) =>
    Array.from(
      new Set([
        ...nextBaseGatewayMethods,
        ...listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []),
      ]),
    );
  // 解析运行时配置
  const runtimeConfig = await startupTrace.measure("runtime.config", () =>
    resolveGatewayRuntimeConfig({
      cfg: cfgAtStart,
      port,
      bind: opts.bind,
      host: opts.host,
      controlUiEnabled: opts.controlUiEnabled,
      openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
      openResponsesEnabled: opts.openResponsesEnabled,
      auth: opts.auth,
      tailscale: opts.tailscale,
    }),
  );
  // 解构运行时配置
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    controlUiBasePath,
