/**
 * 插件运行时模块
 * 负责管理插件注册表状态、激活/停用插件、以及插件事件的调度
 */

import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
} from "./host-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  PLUGIN_REGISTRY_STATE,
  type RegistryState,
  type RegistrySurfaceState,
} from "./runtime-state.js";

const log = createSubsystemLogger("plugins/runtime");

/**
 * 将注册表状态转换为 PluginRegistry 类型
 * @param registry 注册表状态
 * @returns PluginRegistry 实例或 null
 */
function asPluginRegistry(registry: RegistryState["activeRegistry"]): PluginRegistry | null {
  return registry;
}

/**
 * 全局注册表状态
 * 使用全局对象存储，确保在整个进程生命周期内保持单一实例
 */
const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [PLUGIN_REGISTRY_STATE]?: RegistryState;
  };
  let registryState = globalState[PLUGIN_REGISTRY_STATE];
  if (!registryState) {
    registryState = {
      activeRegistry: null,           // 当前激活的插件注册表
      activeVersion: 0,                // 注册表版本号，用于追踪变更
      httpRoute: {
        registry: null,               // HTTP 路由专用注册表
        pinned: false,                // 是否被锁定（锁定后不受 setActivePluginRegistry 影响）
        version: 0,
      },
      channel: {
        registry: null,               // 渠道专用注册表
        pinned: false,
        version: 0,
      },
      key: null,                      // 缓存键
      workspaceDir: null,             // 工作区目录
      runtimeSubagentMode: "default", // 运行子代理模式
      importedPluginIds: new Set<string>(), // 已导入的插件 ID 集合
    };
    globalState[PLUGIN_REGISTRY_STATE] = registryState;
  }
  return registryState;
})();

let pluginAgentEventUnsubscribe: (() => void) | undefined = undefined;

/**
 * 检查注册表是否包含需要清理的插件宿主清理工作
 * @param registry 插件注册表
 * @returns 是否存在需要清理的工作
 */
function registryHasPluginHostCleanupWork(registry: PluginRegistry | null): boolean {
  if (!registry) {
    return false;
  }
  return (
    registry.plugins.some((plugin) => plugin.status === "loaded") || // 存在已加载的插件
    (registry.sessionExtensions?.length ?? 0) > 0 ||                 // 存在会话扩展
    (registry.runtimeLifecycles?.length ?? 0) > 0 ||                 // 存在运行时生命周期
    (registry.agentEventSubscriptions?.length ?? 0) > 0 ||          // 存在代理事件订阅
    (registry.sessionSchedulerJobs?.length ?? 0) > 0                 // 存在会话调度任务
  );
}

/**
 * 清理之前的插件宿主注册表
 * @param params 包含前一个和下一个注册表
 */
async function cleanupPreviousPluginHostRegistry(params: {
  previousRegistry: PluginRegistry;
  nextRegistry: PluginRegistry;
}): Promise<void> {
  const [{ getRuntimeConfig }, { cleanupReplacedPluginHostRegistry }] = await Promise.all([
    import("../config/config.js"),
    import("./host-hook-cleanup.js"),
  ]);
  await cleanupReplacedPluginHostRegistry({
    cfg: getRuntimeConfig(),
    previousRegistry: params.previousRegistry,
    nextRegistry: params.nextRegistry,
  });
}

/**
 * 同步插件代理事件桥接器
 * 将代理事件分发给注册表中的订阅者
 * @param registry 插件注册表
 */
function syncPluginAgentEventBridge(registry: PluginRegistry | null): void {
  pluginAgentEventUnsubscribe?.();
  pluginAgentEventUnsubscribe = undefined;
  if (!registry) {
    return;
  }
  pluginAgentEventUnsubscribe = onAgentEvent((event) => {
    dispatchPluginAgentEventSubscriptions({ registry: state.activeRegistry, event });
  });
}

/**
 * 记录已导入的插件 ID
 * @param pluginId 插件标识符
 */
export function recordImportedPluginId(pluginId: string): void {
  state.importedPluginIds.add(pluginId);
}

/**
 * 安装表面注册表
 * @param surface 表面状态
 * @param registry 注册表
 * @param pinned 是否锁定
 */
function installSurfaceRegistry(
  surface: RegistrySurfaceState,
  registry: RegistryState["activeRegistry"],
  pinned: boolean,
) {
  if (surface.registry === registry && surface.pinned === pinned) {
    return;
  }
  surface.registry = registry;
  surface.pinned = pinned;
  surface.version += 1;
}

/**
 * 同步追踪表面
 * @param surface 表面状态
 * @param registry 注册表
 * @param refreshVersion 是否刷新版本号
 */
function syncTrackedSurface(
  surface: RegistrySurfaceState,
  registry: RegistryState["activeRegistry"],
  refreshVersion = false,
) {
  if (surface.pinned) {
    return;
  }
  if (surface.registry === registry && !surface.pinned) {
    if (refreshVersion) {
      surface.version += 1;
    }
    return;
  }
  installSurfaceRegistry(surface, registry, false);
}

/**
 * 设置激活的插件注册表
 * @param registry 要设置的注册表
 * @param cacheKey 缓存键
 * @param runtimeSubagentMode 运行子代理模式
 * @param workspaceDir 工作区目录
 */
export function setActivePluginRegistry(
  registry: PluginRegistry,
  cacheKey?: string,
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable" = "default",
  workspaceDir?: string,
) {
  const previousRegistry = asPluginRegistry(state.activeRegistry);
  state.activeRegistry = registry;
  state.activeVersion += 1;
  syncTrackedSurface(state.httpRoute, registry, true);   // 同步 HTTP 路由表面
  syncTrackedSurface(state.channel, registry, true);    // 同步渠道表面
  state.key = cacheKey ?? null;
  state.workspaceDir = workspaceDir ?? null;
  state.runtimeSubagentMode = runtimeSubagentMode;
  syncPluginAgentEventBridge(registry);
  if (
    !previousRegistry ||
    previousRegistry === registry ||
    !registryHasPluginHostCleanupWork(previousRegistry)
  ) {
    return;
  }
  // 异步清理之前的注册表
  void cleanupPreviousPluginHostRegistry({
    previousRegistry,
    nextRegistry: registry,
  }).catch((error) => {
    log.warn(`plugin host registry cleanup failed: ${String(error)}`);
  });
}

/**
 * 获取当前激活的插件注册表
 * @returns PluginRegistry 实例或 null
 */
export function getActivePluginRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.activeRegistry);
}

/**
 * 获取当前插件注册表的工作区目录
 * @returns 工作区目录路径或 undefined
 */
export function getActivePluginRegistryWorkspaceDir(): string | undefined {
  return state.workspaceDir ?? undefined;
}

/**
 * 获取或创建激活的插件注册表
 * 如果当前没有注册表，则创建一个空的注册表
 * @returns PluginRegistry 实例
 */
export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.activeRegistry) {
    state.activeRegistry = createEmptyPluginRegistry();
    state.activeVersion += 1;
    syncTrackedSurface(state.httpRoute, state.activeRegistry);
    syncTrackedSurface(state.channel, state.activeRegistry);
  }
  return asPluginRegistry(state.activeRegistry)!;
}

/**
 * 锁定激活的插件 HTTP 路由注册表
 * 锁定后 setActivePluginRegistry 调用不会替换它
 * @param registry 要锁定的注册表
 */
export function pinActivePluginHttpRouteRegistry(registry: PluginRegistry) {
  installSurfaceRegistry(state.httpRoute, registry, true);
}

/**
 * 释放锁定的插件 HTTP 路由注册表
 * @param registry 要释放的注册表，如果不提供则释放当前锁定的
 */
export function releasePinnedPluginHttpRouteRegistry(registry?: PluginRegistry) {
  if (registry && state.httpRoute.registry !== registry) {
    return;
  }
  installSurfaceRegistry(state.httpRoute, state.activeRegistry, false);
}

/**
 * 获取激活的插件 HTTP 路由注册表
 * @returns 注册表或 null
 */
export function getActivePluginHttpRouteRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.httpRoute.registry ?? state.activeRegistry);
}

/**
 * 获取激活的插件 HTTP 路由注册表版本号
 * @returns 版本号
 */
export function getActivePluginHttpRouteRegistryVersion(): number {
  return state.httpRoute.registry ? state.httpRoute.version : state.activeVersion;
}

/**
 * 获取或创建激活的插件 HTTP 路由注册表
 * @returns 注册表
 */
export function requireActivePluginHttpRouteRegistry(): PluginRegistry {
  const existing = getActivePluginHttpRouteRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  installSurfaceRegistry(state.httpRoute, created, false);
  return created;
}

/**
 * 解析激活的插件 HTTP 路由注册表，带回退逻辑
 * @param fallback 回退用的注册表
 * @returns 路由注册表或回退注册表
 */
export function resolveActivePluginHttpRouteRegistry(fallback: PluginRegistry): PluginRegistry {
  const routeRegistry = getActivePluginHttpRouteRegistry();
  if (!routeRegistry) {
    return fallback;
  }
  const routeCount = routeRegistry.httpRoutes?.length ?? 0;
  const fallbackRouteCount = fallback.httpRoutes?.length ?? 0;
  if (routeCount === 0 && fallbackRouteCount > 0) {
    return fallback;
  }
  return routeRegistry;
}

/**
 * 锁定渠道注册表
 * 在网关启动后调用，确保配置架构读取和其他非主注册表加载不会替换渠道插件
 * @param registry 要锁定的注册表
 */
export function pinActivePluginChannelRegistry(registry: PluginRegistry) {
  installSurfaceRegistry(state.channel, registry, true);
}

/**
 * 释放锁定的渠道注册表
 * @param registry 要释放的注册表
 */
export function releasePinnedPluginChannelRegistry(registry?: PluginRegistry) {
  if (registry && state.channel.registry !== registry) {
    return;
  }
  installSurfaceRegistry(state.channel, state.activeRegistry, false);
}

/**
 * 获取激活的渠道插件注册表
 * 当注册表被锁定时，返回启动时的注册表，而不受后续 setActivePluginRegistry 调用影响
 * @returns 注册表或 null
 */
export function getActivePluginChannelRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.channel.registry ?? state.activeRegistry);
}

/**
 * 获取激活的渠道插件注册表版本号
 * @returns 版本号
 */
export function getActivePluginChannelRegistryVersion(): number {
  return state.channel.registry ? state.channel.version : state.activeVersion;
}

/**
 * 获取或创建激活的渠道插件注册表
 * @returns 注册表
 */
export function requireActivePluginChannelRegistry(): PluginRegistry {
  const existing = getActivePluginChannelRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  installSurfaceRegistry(state.channel, created, false);
  return created;
}

/**
 * 获取当前插件注册表缓存键
 * @returns 缓存键或 null
 */
export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

/**
 * 获取当前运行子代理模式
 * @returns 模式：default、explicit 或 gateway-bindable
 */
export function getActivePluginRuntimeSubagentMode(): "default" | "explicit" | "gateway-bindable" {
  return state.runtimeSubagentMode;
}

/**
 * 获取当前插件注册表版本号
 * @returns 版本号
 */
export function getActivePluginRegistryVersion(): number {
  return state.activeVersion;
}

/**
 * 收集已加载的非打包格式插件 ID
 * @param registry 注册表
 * @param ids ID 集合
 */
function collectLoadedPluginIds(
  registry: PluginRegistry | null | undefined,
  ids: Set<string>,
): void {
  if (!registry) {
    return;
  }
  for (const plugin of registry.plugins) {
    // 只收集非打包格式的已加载插件
    if (plugin.status === "loaded" && plugin.format !== "bundle") {
      ids.add(plugin.id);
    }
  }
}

/**
 * 返回在当前进程中被插件运行时或注册表加载导入的插件 ID 列表
 * 这是进程级视图，不是新鲜的导入追踪
 * 打包格式插件被排除，因为它们可以从元数据"加载"而无需导入任何 JS 入口点
 * @returns 已导入的插件 ID 数组（排序后）
 */
export function listImportedRuntimePluginIds(): string[] {
  const imported = new Set(state.importedPluginIds);
  collectLoadedPluginIds(asPluginRegistry(state.activeRegistry), imported);
  collectLoadedPluginIds(asPluginRegistry(state.channel.registry), imported);
  collectLoadedPluginIds(asPluginRegistry(state.httpRoute.registry), imported);
  return [...imported].toSorted((left, right) => left.localeCompare(right));
}

/**
 * 重置插件运行时状态（仅用于测试）
 * 清除活动注册表、表面注册表、缓存键等
 */
export function resetPluginRuntimeStateForTest(): void {
  state.activeRegistry = null;
  state.activeVersion += 1;
  installSurfaceRegistry(state.httpRoute, null, false);
  installSurfaceRegistry(state.channel, null, false);
  state.key = null;
  state.workspaceDir = null;
  state.runtimeSubagentMode = "default";
  state.importedPluginIds.clear();
  syncPluginAgentEventBridge(null);
  // 同时清除插件宿主钩子运行时单例（运行上下文映射、调度任务记录、待处理代理事件处理器、closedRunIds 集合）
  clearPluginHostRuntimeState();
}
