// Control UI module implements model auth behavior.
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";

const EMPTY_AUTH_STATUS: ModelAuthStatusResult = { ts: 0, providers: [] };

export type ModelAuthStatusState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  modelAuthStatusLoading: boolean;
  modelAuthStatusResult: ModelAuthStatusResult | null;
  modelAuthStatusError: string | null;
};

/**
 * True when a provider's auth should be actively monitored on the dashboard.
 *
 * Includes:
 * - Providers with at least one OAuth or bearer-token profile (refreshable
 *   credentials that can expire and need rotation)
 * - Providers with status="missing" (configured-but-not-logged-in — the
 *   server synthesizes these so the UI can prompt for login)
 *
 * Excludes API-key-only providers — their credentials don't expire on a
 * schedule the dashboard can meaningfully monitor.
 *
 * Single source of truth for both the Overview card and the attention-items
 * panel. Keep the two in sync by always routing through this helper.
 */
export function isMonitoredAuthProvider(p: ModelAuthStatusProvider): boolean {
  if (p.status === "missing") {
    return true;
  }
  if (!Array.isArray(p.profiles)) {
    return false;
  }
  return p.profiles.some((prof) => prof.type === "oauth" || prof.type === "token");
}

export async function loadModelAuthStatus(
  client: GatewayBrowserClient,
  opts?: { refresh?: boolean },
): Promise<ModelAuthStatusResult> {
  const params = opts?.refresh ? { refresh: true } : {};
  return (
    (await client.request<ModelAuthStatusResult>("models.authStatus", params)) ?? EMPTY_AUTH_STATUS
  );
}

export async function loadModelAuthStatusState(
  state: ModelAuthStatusState,
  opts?: { refresh?: boolean },
): Promise<void> {
  const client = state.client;
  if (!client || !state.connected) {
    state.modelAuthStatusLoading = false;
    return;
  }
  if (state.modelAuthStatusLoading) {
    return;
  }
  state.modelAuthStatusLoading = true;
  state.modelAuthStatusError = null;
  try {
    const result = await loadModelAuthStatus(client, opts);
    if (state.client !== client || !state.connected) {
      return;
    }
    state.modelAuthStatusResult = result;
  } catch (err) {
    if (state.client !== client || !state.connected) {
      return;
    }
    state.modelAuthStatusError = err instanceof Error ? err.message : String(err);
    state.modelAuthStatusResult = EMPTY_AUTH_STATUS;
  } finally {
    state.modelAuthStatusLoading = false;
  }
}
