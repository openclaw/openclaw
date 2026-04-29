/**
 * Gateway 服务器导出模块
 * 负责导出 Gateway 服务器的核心功能和相关类型
 */

// 导出关闭原因的截断处理函数
export { truncateCloseReason } from "./server/close-reason.js";
// 导出 GatewayServer 类型和 GatewayServerOptions 类型定义
export type { GatewayServer, GatewayServerOptions } from "./server.impl.js";

/**
 * 发送启动追踪日志
 * 仅在设置了 OPENCLAW_GATEWAY_STARTUP_TRACE 环境变量时输出
 * @param name - 追踪事件名称
 * @param durationMs - 当前步骤耗时（毫秒）
 * @param totalMs - 总启动耗时（毫秒）
 */
function emitStartupTrace(name: string, durationMs: number, totalMs: number): void {
  // 检查是否启用启动追踪
  if (!process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) {
    return;
  }
  // 输出追踪日志到标准错误流
  process.stderr.write(
    `[gateway] startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
  );
}

/**
 * 动态加载 server.impl.js 模块
 * 使用性能计时追踪模块加载耗时
 * @returns 返回 server.impl.js 模块的导出内容
 */
async function loadServerImpl() {
  // 记录加载开始时间
  const startupStartedAt = performance.now();
  const before = performance.now();
  try {
    // 动态导入 server.impl.js 模块
    return await import("./server.impl.js");
  } finally {
    // 计算加载耗时并发送追踪日志
    const now = performance.now();
    emitStartupTrace("gateway.server-impl-import", now - before, now - startupStartedAt);
  }
}

/**
 * 启动 Gateway 服务器
 * 延迟加载 server.impl.js 模块以优化启动性能
 * @param args - 传递给 startGatewayServer 的参数
 * @returns 返回 GatewayServer 实例
 */
export async function startGatewayServer(
  ...args: Parameters<typeof import("./server.impl.js").startGatewayServer>
): ReturnType<typeof import("./server.impl.js").startGatewayServer> {
  // 动态加载服务器实现模块
  const mod = await loadServerImpl();
  // 调用实际的服务器启动函数
  return await mod.startGatewayServer(...args);
}

/**
 * 重置模型目录缓存（仅供测试使用）
 * 用于测试环境中清除模型目录缓存
 * @returns Promise<void>
 */
export async function __resetModelCatalogCacheForTest(): Promise<void> {
  // 动态加载模块并调用缓存重置函数
  const mod = await loadServerImpl();
  await mod.__resetModelCatalogCacheForTest();
}
