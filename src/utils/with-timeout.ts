// 带超时功能的 Promise 包装器
// promise: 要执行的 Promise
// timeoutMs: 超时毫秒数
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // 如果超时时间无效，直接返回原 Promise
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | null = null;
  // 创建超时 Promise
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  // 返回竞态结果
  return Promise.race([promise, timeout]).finally(() => {
    // 清理定时器
    if (timer) {
      clearTimeout(timer);
    }
  });
}
