import { hasOperatorReadAccess } from "../app-settings.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../gateway.ts";
import type { PresenceEntry } from "../types.ts";

export type PresenceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello?: GatewayHelloOk | null;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
};

export async function loadPresence(state: PresenceState) {
  if (!state.client || !state.connected) {
    return;
  }
  const auth = state.hello?.auth ?? null;
  if (auth && !hasOperatorReadAccess(auth)) {
    state.presenceEntries = [];
    state.presenceStatus = "Unavailable without operator.read scope.";
    state.presenceError = null;
    return;
  }
  if (state.presenceLoading) {
    return;
  }
  state.presenceLoading = true;
  state.presenceError = null;
  state.presenceStatus = null;
  try {
    const res = await state.client.request("system-presence", {});
    if (Array.isArray(res)) {
      state.presenceEntries = res;
      state.presenceStatus = res.length === 0 ? "No instances yet." : null;
    } else {
      state.presenceEntries = [];
      state.presenceStatus = "No presence payload.";
    }
  } catch (err) {
    state.presenceError = String(err);
  } finally {
    state.presenceLoading = false;
  }
}
