/**
 * 指数退避策略配置类型
 * initialMs: 初始等待时间（毫秒）
 * maxMs: 最大等待时间（毫秒）
 * factor: 指数增长因子
 * jitter: 随机抖动系数（0-1之间）
 */
export type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

/**
 * 根据退避策略和当前尝试次数计算实际等待时间
 * 采用指数退避算法，并添加随机抖动以避免多请求同时重试
 * @param policy - 退避策略配置
 * @param attempt - 当前尝试次数（从1开始）
 * @returns 计算后的等待时间（毫秒）
 */
export function computeBackoff(policy: BackoffPolicy, attempt: number) {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

/**
 * 支持取消的延时Promise
 * @param ms - 延时毫秒数
 * @param abortSignal - 可选的取消信号
 * @returns Promise，在指定时间后resolve，或在取消时reject
 */
export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal) {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      reject(new Error("aborted", { cause: abortSignal?.reason ?? new Error("aborted") }));
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
    }

    timer = setTimeout(() => {
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      timer = null;
      resolve();
    }, ms);

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      }
    }
  });
}
