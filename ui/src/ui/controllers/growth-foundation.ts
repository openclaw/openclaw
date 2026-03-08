// ui/src/ui/controllers/growth-foundation.ts
// Fetches the same-origin Control UI summary for the growth foundation panel.
import {
  CONTROL_UI_GROWTH_FOUNDATION_PATH,
  CONTROL_UI_GROWTH_REVIEW_ACTION_PATH,
  type ControlUiGrowthFoundationSnapshot,
  type ControlUiGrowthReviewAction,
  type ControlUiGrowthReviewActionResponse,
} from "../../../../src/gateway/control-ui-contract.js";
import { normalizeBasePath } from "../navigation.ts";

export type GrowthFoundationState = {
  basePath: string;
  growthFoundation: ControlUiGrowthFoundationSnapshot | null;
  growthFoundationActionBusyKey?: string | null;
  growthFoundationActionError?: string | null;
};

export async function loadGrowthFoundationSummary(state: GrowthFoundationState) {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof fetch !== "function") {
    return;
  }

  const basePath = normalizeBasePath(state.basePath ?? "");
  const url = basePath
    ? `${basePath}${CONTROL_UI_GROWTH_FOUNDATION_PATH}`
    : CONTROL_UI_GROWTH_FOUNDATION_PATH;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
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
  const basePath = normalizeBasePath(state.basePath ?? "");
  const url = basePath
    ? `${basePath}${CONTROL_UI_GROWTH_REVIEW_ACTION_PATH}`
    : CONTROL_UI_GROWTH_REVIEW_ACTION_PATH;
  state.growthFoundationActionBusyKey = params.itemKey;
  state.growthFoundationActionError = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
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
