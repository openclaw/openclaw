// 运行状态状态补丁类型定义
// busy: 是否忙碌中
// activeRuns: 当前活跃运行数量
// lastRunActivityAt: 最后一次运行活动时间戳
export type RunStateStatusPatch = {
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
};

// 运行状态状态槽函数类型，接收状态补丁
export type RunStateStatusSink = (patch: RunStateStatusPatch) => void;

// 运行状态机参数类型
// setStatus: 状态更新回调函数
// abortSignal: 中止信号，用于取消操作
// heartbeatMs: 心跳间隔毫秒数
// now: 时间获取函数，默认 Date.now
type RunStateMachineParams = {
  setStatus?: RunStateStatusSink;
  abortSignal?: AbortSignal;
  heartbeatMs?: number;
  now?: () => number;
};

// 默认运行活动心跳间隔：60秒
const DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS = 60_000;

// 创建运行状态机
// 返回一个包含状态控制方法的对象
export function createRunStateMachine(params: RunStateMachineParams) {
  // 使用提供的心跳间隔或默认值
  const heartbeatMs = params.heartbeatMs ?? DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS;
  // 使用提供的时间函数或默认 Date.now
  const now = params.now ?? Date.now;
  // 活跃运行计数器
  let activeRuns = 0;
  // 心跳定时器引用
  let runActivityHeartbeat: ReturnType<typeof setInterval> | null = null;
  // 生命周期是否活跃（未中止）
  let lifecycleActive = !params.abortSignal?.aborted;

  // 发布状态更新
  const publish = () => {
    // 如果生命周期已结束，不发布
    if (!lifecycleActive) {
      return;
    }
    // 调用状态更新回调
    params.setStatus?.({
      activeRuns,
      busy: activeRuns > 0,
      lastRunActivityAt: now(),
    });
  };

  // 清除心跳定时器
  const clearHeartbeat = () => {
    if (!runActivityHeartbeat) {
      return;
    }
    clearInterval(runActivityHeartbeat);
    runActivityHeartbeat = null;
  };

  // 确保心跳定时器运行
  // 当有活跃运行且生命周期活跃时启动心跳
  const ensureHeartbeat = () => {
    if (runActivityHeartbeat || activeRuns <= 0 || !lifecycleActive) {
      return;
    }
    // 设置定时心跳发布状态
    runActivityHeartbeat = setInterval(() => {
      if (!lifecycleActive || activeRuns <= 0) {
        clearHeartbeat();
        return;
      }
      publish();
    }, heartbeatMs);
    // 允许定时器在没有任何引用时仍被清理
    runActivityHeartbeat.unref?.();
  };

  // 停用状态机
  const deactivate = () => {
    lifecycleActive = false;
    clearHeartbeat();
  };

  // 中止信号处理
  const onAbort = () => {
    deactivate();
  };

  // 如果已中止，立即处理
  if (params.abortSignal?.aborted) {
    onAbort();
  } else {
    // 否则监听中止事件
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  // 如果生命周期仍活跃，重置继承的状态
  if (lifecycleActive) {
    // 重置从前一个进程生命周期继承的状态
    params.setStatus?.({
      activeRuns: 0,
      busy: false,
    });
  }

  // 返回状态机公共接口
  return {
    // 检查是否活跃
    isActive() {
      return lifecycleActive;
    },
    // 运行开始回调
    onRunStart() {
      activeRuns += 1;
      publish();
      ensureHeartbeat();
    },
    // 运行结束回调
    onRunEnd() {
      activeRuns = Math.max(0, activeRuns - 1);
      // 如果没有活跃运行了，清除心跳
      if (activeRuns <= 0) {
        clearHeartbeat();
      }
      publish();
    },
    // 停用方法
    deactivate,
  };
}
