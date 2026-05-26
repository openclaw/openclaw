import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelAuthStatusResult } from "../types.ts";

const FALLBACK: ModelAuthStatusResult = { ts: 0, providers: [] };
const EMPTY_USAGE_RETRY_DELAY_MS = 750;

export type ModelAuthStatusState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  modelAuthStatusLoading: boolean;
  modelAuthStatusResult: ModelAuthStatusResult | null;
  modelAuthStatusError: string | null;
};

function hasUsageWindow(result: ModelAuthStatusResult): boolean {
  return result.providers.some((provider) => (provider.usage?.windows.length ?? 0) > 0);
}

function shouldRetryEmptyUsage(result: ModelAuthStatusResult): boolean {
  if (hasUsageWindow(result)) {
    return false;
  }
  return result.providers.some((provider) =>
    provider.profiles.some((profile) => profile.type === "oauth" || profile.type === "token"),
  );
}

async function waitForEmptyUsageRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Fetch the current auth-status snapshot. Rethrows transport errors so the
 * state wrapper can distinguish "not loaded yet" (ts === 0) from "load failed"
 * (error set).
 *
 * Pass `{ refresh: true }` to bypass the gateway's 60s cache — useful after
 * a user-initiated refresh, where serving a minute-old snapshot would
 * contradict the affordance.
 */
export async function loadModelAuthStatus(
  client: GatewayBrowserClient,
  opts?: { refresh?: boolean },
): Promise<ModelAuthStatusResult> {
  const params = opts?.refresh ? { refresh: true } : {};
  const result = await client.request<ModelAuthStatusResult>("models.authStatus", params);
  return result ?? FALLBACK;
}

export async function loadModelAuthStatusState(
  state: ModelAuthStatusState,
  opts?: { refresh?: boolean; emptyUsageRetryDelayMs?: number },
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.modelAuthStatusLoading) {
    return;
  }
  state.modelAuthStatusLoading = true;
  state.modelAuthStatusError = null;
  try {
    const first = await loadModelAuthStatus(state.client, opts);
    if (shouldRetryEmptyUsage(first)) {
      await waitForEmptyUsageRetry(opts?.emptyUsageRetryDelayMs ?? EMPTY_USAGE_RETRY_DELAY_MS);
      try {
        state.modelAuthStatusResult = await loadModelAuthStatus(state.client, { refresh: true });
      } catch {
        state.modelAuthStatusResult = first;
      }
    } else {
      state.modelAuthStatusResult = first;
    }
  } catch (err) {
    state.modelAuthStatusError = err instanceof Error ? err.message : String(err);
    state.modelAuthStatusResult = FALLBACK;
  } finally {
    state.modelAuthStatusLoading = false;
  }
}
