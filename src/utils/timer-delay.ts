// Node.js setTimeout 能接受的最大安全延迟毫秒数
export const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;

// 解析安全的超时延迟毫秒数
// delayMs: 原始延迟毫秒数
// opts.minMs: 最小值，默认为 1
export function resolveSafeTimeoutDelayMs(delayMs: number, opts?: { minMs?: number }): number {
  // 获取原始最小值，默认 1
  const rawMinMs = opts?.minMs ?? 1;
  // 计算最终最小值（在安全和有效范围内）
  const minMs = Math.min(
    MAX_SAFE_TIMEOUT_DELAY_MS,
    Math.max(0, Number.isFinite(rawMinMs) ? Math.floor(rawMinMs) : 1),
  );
  // 计算候选延迟值
  const candidateMs = Number.isFinite(delayMs) ? Math.floor(delayMs) : minMs;
  // 返回限制在 minMs 和最大安全值之间的值
  return Math.min(MAX_SAFE_TIMEOUT_DELAY_MS, Math.max(minMs, candidateMs));
}

// 设置安全超时
// callback: 超时回调函数
// delayMs: 延迟毫秒数
// opts.minMs: 最小延迟值
export function setSafeTimeout(
  callback: () => void,
  delayMs: number,
  opts?: { minMs?: number },
): NodeJS.Timeout {
  return setTimeout(callback, resolveSafeTimeoutDelayMs(delayMs, opts));
}
