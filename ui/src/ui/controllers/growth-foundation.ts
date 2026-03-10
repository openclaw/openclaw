// ui/src/ui/controllers/growth-foundation.ts
// Fetches growth foundation data from the currently selected gateway target.
import {
  CONTROL_UI_GROWTH_FOUNDATION_PATH,
  CONTROL_UI_GROWTH_REVIEW_ACTION_PATH,
  type ControlUiGrowthFoundationSnapshot,
  type ControlUiGrowthReviewAction,
  type ControlUiGrowthReviewActionResponse,
} from "../../../../src/gateway/control-ui-contract.js";
import { buildControlUiHttpUrl } from "../control-ui-url.ts";

export type GrowthFoundationState = {
  basePath: string;
  settings?: { gatewayUrl?: string | null; token?: string | null };
  password?: string | null;
  hello?: { auth?: { deviceToken?: string | null } } | null;
  growthFoundation: ControlUiGrowthFoundationSnapshot | null;
  growthFoundationActionBusyKey?: string | null;
  growthFoundationActionError?: string | null;
};

function buildGrowthFoundationHeaders(
  state: GrowthFoundationState,
  headers: Record<string, string>,
): Record<string, string> {
  const deviceToken = state.hello?.auth?.deviceToken?.trim();
  const sharedToken = state.settings?.token?.trim();
  const password = state.password?.trim();
  const authToken = deviceToken || sharedToken || password;
  return authToken ? { ...headers, Authorization: `Bearer ${authToken}` } : headers;
}

export async function loadGrowthFoundationSummary(state: GrowthFoundationState) {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof fetch !== "function") {
    return;
  }

  const url = buildControlUiHttpUrl({
    gatewayUrl: state.settings?.gatewayUrl,
    basePath: state.basePath,
    path: CONTROL_UI_GROWTH_FOUNDATION_PATH,
  });

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildGrowthFoundationHeaders(state, { Accept: "application/json" }),
      credentials: "same-origin",
    });
    if (!res.ok) {
      return;
    }
    state.growthFoundation = (await res.json()) as ControlUiGrowthFoundationSnapshot;
  } catch {
    // Ignore fetch failures; the overview remains usable without this panel.
  }
}

export async function submitGrowthFoundationReviewAction(
  state: GrowthFoundationState,
  params: { action: ControlUiGrowthReviewAction; itemKey: string },
) {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return;
  }
  if (state.growthFoundationActionBusyKey) {
    return;
  }
  const url = buildControlUiHttpUrl({
    gatewayUrl: state.settings?.gatewayUrl,
    basePath: state.basePath,
    path: CONTROL_UI_GROWTH_REVIEW_ACTION_PATH,
  });
  state.growthFoundationActionBusyKey = params.itemKey;
  state.growthFoundationActionError = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildGrowthFoundationHeaders(state, {
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
      credentials: "same-origin",
      body: JSON.stringify({
        action: params.action,
        itemKey: params.itemKey,
        projectId:
          state.growthFoundation?.workspaceProjectId ?? state.growthFoundation?.projectId ?? "",
      }),
    });
    const payload =
      ((await res.json().catch(() => null)) as ControlUiGrowthReviewActionResponse | null) ?? null;
    if (!res.ok || !payload?.success || !payload.snapshot) {
      throw new Error(payload?.error || `HTTP ${res.status}`);
    }
    state.growthFoundation = payload.snapshot;
  } catch (error) {
    state.growthFoundationActionError =
      error instanceof Error ? error.message : "growth review action failed";
  } finally {
    state.growthFoundationActionBusyKey = null;
  }
}
