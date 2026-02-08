/**
 * Fetch with AbortController-based timeout.
 * Prevents indefinite hangs when API requests stall.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
