<<<<<<< HEAD
import type { GatewayBrowserClient } from "../gateway";
=======
import type { GatewayBrowserClient } from "../gateway.ts";
>>>>>>> upstream/main

export type NodesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  lastError: string | null;
};

export async function loadNodes(state: NodesState, opts?: { quiet?: boolean }) {
<<<<<<< HEAD
  if (!state.client || !state.connected) return;
  if (state.nodesLoading) return;
  state.nodesLoading = true;
  if (!opts?.quiet) state.lastError = null;
  try {
    const res = (await state.client.request("node.list", {})) as {
      nodes?: Array<Record<string, unknown>>;
    };
    state.nodes = Array.isArray(res.nodes) ? res.nodes : [];
  } catch (err) {
    if (!opts?.quiet) state.lastError = String(err);
=======
  if (!state.client || !state.connected) {
    return;
  }
  if (state.nodesLoading) {
    return;
  }
  state.nodesLoading = true;
  if (!opts?.quiet) {
    state.lastError = null;
  }
  try {
    const res = await state.client.request<{ nodes?: Record<string, unknown> }>("node.list", {});
    state.nodes = Array.isArray(res.nodes) ? res.nodes : [];
  } catch (err) {
    if (!opts?.quiet) {
      state.lastError = String(err);
    }
>>>>>>> upstream/main
  } finally {
    state.nodesLoading = false;
  }
}
