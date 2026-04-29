import { asFiniteNumber } from "../shared/number-coercion.js";
import { sleep } from "../utils.js";
import { generateSecureFraction } from "./secure-random.js";

/**
 * 重试配置选项
 * attempts: 最大尝试次数
 * minDelayMs: 最小延迟时间（毫秒）
 * maxDelayMs: 最大延迟时间（毫秒）
 * jitter: 抖动系数（0-1之间），用于随机化延迟避免多请求同时重试
 */
export type RetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
};

/**
 * 重试信息的详细类型
 * attempt: 当前尝试次数
 * maxAttempts: 最大尝试次数
 * delayMs: 本次延迟时间
 * err: 捕获的错误对象
 * label: 可选的标签描述
 */
export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  err: unknown;
  label?: string;
};

/**
 * 重试选项完整类型，包含回调函数
 * shouldRetry: 判断是否应继续重试的函数
 * retryAfterMs: 从错误中提取重试延迟时间的函数
 * onRetry: 每次重试前调用的回调函数
 */
export type RetryOptions = RetryConfig & {
  label?: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  onRetry?: (info: RetryInfo) => void;
};

/**
 * 默认重试配置常量
 * 尝试3次，最小延迟300ms，最大延迟30秒，无抖动
 */
const DEFAULT_RETRY_CONFIG = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0,
};

/**
 * 将值限制在指定范围内的辅助函数
 * @param value - 待限制的值
 * @param fallback - 如果值无效时使用的默认值
 * @param min - 可选的最小值
 * @param max - 可选的最大值
 */
const clampNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const next = asFiniteNumber(value);
  if (next === undefined) {
    return fallback;
  }
  const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
  const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(next, floor), ceiling);
};

/**
 * 解析并合并重试配置
 * @param defaults - 默认配置
 * @param overrides - 要覆盖的配置
 * @returns 合并后的完整配置，确保所有值都在有效范围内
 */
export function resolveRetryConfig(
  defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = Math.max(1, Math.round(clampNumber(overrides?.attempts, defaults.attempts, 1)));
  const minDelayMs = Math.max(
    0,
    Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0)),
  );
  const jitter = clampNumber(overrides?.jitter, defaults.jitter, 0, 1);
  return { attempts, minDelayMs, maxDelayMs, jitter };
}

/**
 * 对延迟应用随机抖动
 * @param delayMs - 基础延迟时间
 * @param jitter - 抖动系数
 * @returns 应用抖动后的延迟时间
 */
function applyJitter(delayMs: number, jitter: number): number {
  if (jitter <= 0) {
    return delayMs;
  }
  const offset = (generateSecureFraction() * 2 - 1) * jitter;
  return Math.max(0, Math.round(delayMs * (1 + offset)));
}

/**
 * 异步重试函数，支持简单和高级两种调用方式
 * @param fn - 要执行并可能重试的异步函数
 * @param attemptsOrOptions - 尝试次数或完整配置选项
 * @param initialDelayMs - 初始延迟时间（仅简单模式使用）
 * @returns Promise resolves 为函数执行结果
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  attemptsOrOptions: number | RetryOptions = 3,
  initialDelayMs = 300,
): Promise<T> {
  if (typeof attemptsOrOptions === "number") {
    const attempts = Math.max(1, Math.round(attemptsOrOptions));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) {
          break;
        }
        const delay = initialDelayMs * 2 ** i;
        await sleep(delay);
      }
    }
    throw lastErr ?? new Error("Retry failed");
  }

  const options = attemptsOrOptions;

  const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
  const maxAttempts = resolved.attempts;
  const minDelayMs = resolved.minDelayMs;
  const maxDelayMs =
    Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0
      ? resolved.maxDelayMs
      : Number.POSITIVE_INFINITY;
  const jitter = resolved.jitter;
  const shouldRetry = options.shouldRetry ?? (() => true);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        break;
      }

      const retryAfterMs = options.retryAfterMs?.(err);
      const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
      const baseDelay = hasRetryAfter
        ? Math.max(retryAfterMs, minDelayMs)
        : minDelayMs * 2 ** (attempt - 1);
      let delay = Math.min(baseDelay, maxDelayMs);
      delay = applyJitter(delay, jitter);
      delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);

      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: delay,
        err,
        label: options.label,
      });
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw lastErr ?? new Error("Retry failed");
}
