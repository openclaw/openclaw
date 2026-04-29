import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import type { CliDeps } from "./deps.types.js";
import {
  CLI_OUTBOUND_SEND_FACTORY,
  createOutboundSendDepsFromCliSource,
} from "./outbound-send-mapping.js";

/**
 * Lazy-loaded per-channel send functions, keyed by channel ID.
 * Values are proxy functions that dynamically import the real module on first use.
 */
export type { CliDeps } from "./deps.types.js";
type RuntimeSend = {
  sendMessage: (...args: unknown[]) => Promise<unknown>;
};
type RuntimeSendModule = {
  runtimeSend: RuntimeSend;
};

/**
 * 非通道依赖键集合
 * 这些键是对象内置属性或 CLI 内部依赖，不应被视为通道 ID 进行懒加载
 */
const NON_CHANNEL_DEP_KEYS = new Set([
  "__proto__",
  "constructor",
  "cron",
  "cronConfig",
  "cronEnabled",
  "defaultAgentId",
  "enqueueSystemEvent",
  "getQueueSize",
  "hasOwnProperty",
  "inspect",
  "log",
  "migrateOrphanedSessionKeys",
  "nowMs",
  "onEvent",
  "requestHeartbeatNow",
  "resolveSessionStorePath",
  "runHeartbeatOnce",
  "runIsolatedAgentJob",
  "runtime",
  "sendCronFailureAlert",
  "sessionStorePath",
  "storePath",
  "then",
  "toJSON",
  "toString",
  "valueOf",
]);

/**
 * 通道模块缓存映射表
 * 用于存储已加载的通道运行时发送器，按通道 ID 缓存
 */
const senderCache = new Map<string, Promise<RuntimeSend>>();

/**
 * 创建通道的懒加载发送函数代理
 * 通道模块在首次调用时加载，之后缓存以供重用
 * @param channelId - 通道唯一标识符
 * @param loader - 异步加载通道模块的函数
 * @returns 代理发送函数，可动态调用通道的 sendMessage 方法
 */
function createLazySender(
  channelId: string,
  loader: () => Promise<RuntimeSendModule>,
): (...args: unknown[]) => Promise<unknown> {
  const loadRuntimeSend = createLazyRuntimeSurface(loader, ({ runtimeSend }) => runtimeSend);
  return async (...args: unknown[]) => {
    let cached = senderCache.get(channelId);
    if (!cached) {
      cached = loadRuntimeSend();
      senderCache.set(channelId, cached);
    }
    const runtimeSend = await cached;
    return await runtimeSend.sendMessage(...args);
  };
}

/**
 * 创建默认的 CLI 依赖项
 * 返回一个 Proxy 对象，用于懒加载各通道的发送函数
 * 当访问非内置属性时，自动解析为对应通道的发送器
 * @returns CLI 依赖项对象，包含懒加载的通道发送器
 */
export function createDefaultDeps(): CliDeps {
  const deps: CliDeps = {};

  /**
   * 解析器函数：根据通道 ID 创建对应的懒加载发送器
   * @param channelId - 通道唯一标识符
   * @returns 通道的懒加载发送函数
   */
  const resolveSender = (channelId: string) =>
    createLazySender(channelId, async () => {
      const { createChannelOutboundRuntimeSend } =
        await import("./send-runtime/channel-outbound-send.js");
      return {
        runtimeSend: createChannelOutboundRuntimeSend({
          channelId: channelId as import("../channels/plugins/types.public.js").ChannelId,
          unavailableMessage: `${channelId} outbound adapter is unavailable.`,
        }) as RuntimeSend,
      } satisfies RuntimeSendModule;
    });

  /**
   * 为 deps 对象定义 CLI_OUTBOUND_SEND_FACTORY 属性
   * 这是一个特殊的符号键，用于标识发送器工厂函数
   */
  Object.defineProperty(deps, CLI_OUTBOUND_SEND_FACTORY, {
    configurable: false,
    enumerable: false,
    value: resolveSender,
    writable: false,
  });

  /**
   * 返回 deps 对象的 Proxy
   * 拦截 get 操作，当访问的属性的值不存在且不是非通道键时，
   * 自动创建对应的通道发送器并缓存
   */
  return new Proxy(deps, {
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }
      const existing = Reflect.get(target, property, receiver);
      if (existing !== undefined || NON_CHANNEL_DEP_KEYS.has(property)) {
        return existing;
      }
      const sender = resolveSender(property);
      Reflect.set(target, property, sender, receiver);
      return sender;
    },
  });
}

/**
 * 从 CLI 依赖项创建出站发送依赖项
 * 用于将 CLI 层的依赖映射到基础设施层的出站发送依赖
 * @param deps - CLI 依赖项
 * @returns 出站发送依赖项
 */
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
