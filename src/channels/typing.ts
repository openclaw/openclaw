// 导入打字指示器保活循环创建函数
import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";
// 导入打字开始守卫创建函数
import { createTypingStartGuard } from "./typing-start-guard.js";

// 打字回调类型定义
// onReplyStart: 回复开始时调用的异步函数
// onIdle: 空闲时调用的可选函数
// onCleanup: 打字控制器被清理时调用的函数（如 NO_REPLY）
export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g. on NO_REPLY). */
  onCleanup?: () => void;
};

// 创建打字回调参数类型
export type CreateTypingCallbacksParams = {
  start: () => Promise<void>;  // 开始打字指示器
  stop?: () => Promise<void>;  // 停止打字指示器
  onStartError: (err: unknown) => void;  // 开始出错处理
  onStopError?: (err: unknown) => void;  // 停止出错处理
  keepaliveIntervalMs?: number;  // 保活间隔毫秒数
  /** Stop keepalive after this many consecutive start() failures. Default: 2 */
  maxConsecutiveFailures?: number;  // 最大连续失败次数
  /** Maximum duration for typing indicator before auto-cleanup (safety TTL). Default: 60s */
  maxDurationMs?: number;  // 最大持续时间（安全 TTL）
};

// 创建打字回调函数
export function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks {
  const stop = params.stop;
  // 默认保活间隔 3 秒
  const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3_000;
  // 最大连续失败次数至少为 1，默认 2
  const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
  // 默认最大持续时间 60 秒
  const maxDurationMs = params.maxDurationMs ?? 60_000; // Default 60s TTL
  let stopSent = false;  // 是否已发送停止信号
  let closed = false;  // 是否已关闭
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;  // TTL 定时器

  // 创建打字开始守卫
  const startGuard = createTypingStartGuard({
    isSealed: () => closed,  // 关闭时密封
    onStartError: params.onStartError,
    maxConsecutiveFailures,
    onTrip: () => {
      keepaliveLoop.stop();  // 停止保活循环
    },
  });

  // 触发开始打字
  const fireStart = async (): Promise<void> => {
    await startGuard.run(() => params.start());
  };

  // 创建打字保活循环
  const keepaliveLoop = createTypingKeepaliveLoop({
    intervalMs: keepaliveIntervalMs,
    onTick: fireStart,
  });

  // TTL 安全：超过最大持续时间自动停止打字
  const startTtlTimer = () => {
    if (maxDurationMs <= 0) {
      return;
    }
    clearTtlTimer();
    ttlTimer = setTimeout(() => {
      if (!closed) {
        console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping typing indicator`);
        fireStop();
      }
    }, maxDurationMs);
  };

  // 清除 TTL 定时器
  const clearTtlTimer = () => {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
  };

  // 回复开始回调
  const onReplyStart = async () => {
    if (closed) {
      return;
    }
    stopSent = false;
    startGuard.reset();  // 重置守卫
    keepaliveLoop.stop();  // 停止保活循环
    clearTtlTimer();  // 清除 TTL 定时器
    await fireStart();  // 触发开始
    if (startGuard.isTripped()) {  // 如果守卫被触发
      return;
    }
    keepaliveLoop.start();  // 启动保活循环
    startTtlTimer(); // 启动 TTL 安全定时器
  };

  // 触发停止打字
  const fireStop = () => {
    closed = true;
    keepaliveLoop.stop();  // 停止保活循环
    clearTtlTimer(); // 清除 TTL 定时器
    if (!stop || stopSent) {
      return;
    }
    stopSent = true;
    // 捕获停止错误
    void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
  };

  // 返回打字回调对象
  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}
