// 导出内部钩子模块的所有导出
export * from "./internal-hooks.js";

// 导出钩子事件类型
export type HookEventType = import("./internal-hooks.js").InternalHookEventType;
// 导出钩子事件类型别名
export type HookEvent = import("./internal-hooks.js").InternalHookEvent;
// 导出钩子处理器类型
export type HookHandler = import("./internal-hook-types.js").InternalHookHandler;

// 导出内部钩子模块的函数作为公共 API
export {
  registerInternalHook as registerHook,           // 注册钩子
  unregisterInternalHook as unregisterHook,       // 取消注册钩子
  clearInternalHooks as clearHooks,               // 清除所有钩子
  getRegisteredEventKeys as getRegisteredHookEventKeys, // 获取已注册的事件键
  triggerInternalHook as triggerHook,             // 触发钩子
  createInternalHookEvent as createHookEvent,    // 创建钩子事件
} from "./internal-hooks.js";
