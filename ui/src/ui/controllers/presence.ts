<<<<<<< HEAD
import type { GatewayBrowserClient } from "../gateway";
import type { PresenceEntry } from "../types";
=======
import type { GatewayBrowserClient } from "../gateway.ts";
import type { PresenceEntry } from "../types.ts";
>>>>>>> upstream/main

export type PresenceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
};

export async function loadPresence(state: PresenceState) {
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
  if (state.presenceLoading) return;
=======
  if (!state.client || !state.connected) {
    return;
  }
  if (state.presenceLoading) {
    return;
  }
>>>>>>> upstream/main
  state.presenceLoading = true;
  state.presenceError = null;
  state.presenceStatus = null;
  try {
<<<<<<< HEAD
    const res = (await state.client.request("system-presence", {})) as PresenceEntry[] | undefined;
=======
    const res = await state.client.request("system-presence", {});
>>>>>>> upstream/main
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
