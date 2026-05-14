import type { GatewayBrowserClient } from "../gateway.ts";
import type { WorkspaceBoundaryStatus } from "../types.ts";

const FALLBACK: WorkspaceBoundaryStatus = {
  state: "unavailable",
  reason: "canonical_root_unavailable",
  boundary_scope: "workspace-vs-canon",
  workspace_root: "",
  canonical_root: null,
  recommended_next_action:
    "Configure or expose an approved canonical root signal before treating workspace boundary posture as confirmed.",
};

export type WorkspaceBoundaryStatusState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  workspaceBoundaryStatusLoading: boolean;
  workspaceBoundaryStatusResult: WorkspaceBoundaryStatus | null;
  workspaceBoundaryStatusError: string | null;
};

export async function loadWorkspaceBoundaryStatus(
  client: GatewayBrowserClient,
): Promise<WorkspaceBoundaryStatus> {
  const result = await client.request<WorkspaceBoundaryStatus>(
    "system.workspaceBoundaryStatus",
    {},
  );
  return result ?? FALLBACK;
}

export async function loadWorkspaceBoundaryStatusState(
  state: WorkspaceBoundaryStatusState,
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.workspaceBoundaryStatusLoading) {
    return;
  }
  state.workspaceBoundaryStatusLoading = true;
  state.workspaceBoundaryStatusError = null;
  try {
    state.workspaceBoundaryStatusResult = await loadWorkspaceBoundaryStatus(state.client);
  } catch (err) {
    state.workspaceBoundaryStatusError = err instanceof Error ? err.message : String(err);
    state.workspaceBoundaryStatusResult = FALLBACK;
  } finally {
    state.workspaceBoundaryStatusLoading = false;
  }
}
