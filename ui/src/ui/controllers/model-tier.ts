import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelTierMode } from "../model-tier-types.ts";

export type ModelTierState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  modelTierMode: ModelTierMode;
  modelTierOverrides: Record<string, ModelTierMode>;
  modelTierLoading: boolean;
};

type ModelModeGetResult = {
  globalMode: ModelTierMode;
  agentOverrides: Record<string, ModelTierMode>;
};

type ModelModeSetResult = {
  ok: boolean;
  globalMode: ModelTierMode;
};

type ModelModeAgentSetResult = {
  ok: boolean;
  agentId: string;
  mode: ModelTierMode | "inherit";
  effectiveMode: ModelTierMode;
};

export async function loadModelTier(state: ModelTierState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = (await state.client.request("model-mode.get", {})) as ModelModeGetResult;
    state.modelTierMode = res.globalMode ?? "economy";
    state.modelTierOverrides = res.agentOverrides ?? {};
  } catch {
    // If endpoint doesn't exist yet, default to economy
    state.modelTierMode = "economy";
    state.modelTierOverrides = {};
  }
}

export async function setModelTierGlobal(state: ModelTierState, mode: ModelTierMode) {
  if (!state.client || !state.connected) {
    return;
  }
  // Optimistic update — reflect immediately in UI
  const previousMode = state.modelTierMode;
  state.modelTierMode = mode;
  state.modelTierLoading = true;
  try {
    const res = (await state.client.request("model-mode.set", { mode })) as ModelModeSetResult;
    if (res.ok) {
      state.modelTierMode = res.globalMode;
    } else {
      // Revert on failure
      state.modelTierMode = previousMode;
    }
  } catch (err) {
    console.error("Failed to set model tier:", err);
    // Revert on error
    state.modelTierMode = previousMode;
  } finally {
    state.modelTierLoading = false;
  }
}

export async function setModelTierAgent(
  state: ModelTierState,
  agentId: string,
  mode: ModelTierMode | "inherit",
) {
  if (!state.client || !state.connected) {
    return;
  }
  // Optimistic update
  const previousOverrides = { ...state.modelTierOverrides };
  if (mode === "inherit") {
    const next = { ...state.modelTierOverrides };
    delete next[agentId];
    state.modelTierOverrides = next;
  } else {
    state.modelTierOverrides = { ...state.modelTierOverrides, [agentId]: mode as ModelTierMode };
  }
  state.modelTierLoading = true;
  try {
    const res = (await state.client.request("model-mode.agent-set", {
      agentId,
      mode,
    })) as ModelModeAgentSetResult;
    if (!res.ok) {
      // Revert on failure
      state.modelTierOverrides = previousOverrides;
    }
  } catch (err) {
    console.error("Failed to set agent model tier:", err);
    state.modelTierOverrides = previousOverrides;
  } finally {
    state.modelTierLoading = false;
  }
}
