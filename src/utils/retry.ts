export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  timeoutMs?: number; // per-attempt timeout
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function retryWithBackoff<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 200;
  const maxMs = opts.maxMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 15000;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fn(controller.signal);
      clearTimeout(timeout);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      // If aborted due to external signal, don't retry
      if (controller.signal.aborted && (err as any)?.name === "AbortError") {
        // fallthrough to retry only if not final attempt
      }
      if (i + 1 >= attempts) break;
      const backoff = Math.min(maxMs, baseMs * Math.pow(2, i));
      await sleep(backoff + Math.floor(Math.random() * baseMs));
    }
  }
  throw lastErr;
}
