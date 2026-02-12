import { html, nothing } from "lit";
import type { AppViewState } from "./app-view-state.ts";
import type { UsageState } from "./controllers/usage.ts";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { loadUsage } from "./controllers/usage.ts";

// Module-scope debounce for usage date changes (avoids type-unsafe hacks on state object)
let usageDateDebounceTimeout: number | null = null;
export const debouncedLoadUsage = (state: UsageState) => {
  if (usageDateDebounceTimeout) {
    clearTimeout(usageDateDebounceTimeout);
  }
  usageDateDebounceTimeout = window.setTimeout(() => void loadUsage(state), 400);
};

let configWarmupRaf: number | null = null;
const CONFIG_RENDER_START = 6;
const CONFIG_RENDER_STEP = 6;
const CONFIG_RENDER_MAX = 84;

function cancelConfigWarmup() {
  if (configWarmupRaf != null) {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(configWarmupRaf);
    } else {
      clearTimeout(configWarmupRaf);
    }
    configWarmupRaf = null;
  }
}

function shouldUseProgressiveConfigRender(state: AppViewState): boolean {
  return (
    state.tab === "config" &&
    state.configFormMode === "form" &&
    !state.configSchemaLoading &&
    !state.configActiveSection &&
    state.configSearchQuery.trim().length === 0
  );
}

export function warmConfigRender(state: AppViewState, reset = false) {
  if (reset) {
    state.configRenderLimit = CONFIG_RENDER_START;
  }

  if (!shouldUseProgressiveConfigRender(state)) {
    cancelConfigWarmup();
    state.configRenderLimit = CONFIG_RENDER_MAX;
    return;
  }

  if (configWarmupRaf != null) {
    return;
  }

  const tick = () => {
    configWarmupRaf = null;
    if (!shouldUseProgressiveConfigRender(state)) {
      state.configRenderLimit = CONFIG_RENDER_MAX;
      return;
    }
    const next = Math.min(CONFIG_RENDER_MAX, state.configRenderLimit + CONFIG_RENDER_STEP);
    if (next !== state.configRenderLimit) {
      state.configRenderLimit = next;
    }
    if (next < CONFIG_RENDER_MAX) {
      configWarmupRaf =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(tick)
          : window.setTimeout(tick, 16);
    }
  };

  configWarmupRaf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(tick)
      : window.setTimeout(tick, 16);
}

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

export function resolveDashboardAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) {
    return candidate;
  }
  return identity?.avatarUrl;
}

export function renderConfigTopbarMeta(state: AppViewState, isConfig: boolean) {
  if (!isConfig) {
    return nothing;
  }
  return html`
    <div class="topbar-meta topbar-meta--config">
      <div class="pill pill--sm">
        <span>Mode</span>
        <span class="mono">${state.configFormMode.toUpperCase()}</span>
      </div>
      <div class="pill pill--sm ${state.configFormDirty ? "pill--danger" : "pill--ok"}">
        <span>Draft</span>
        <span class="mono">${state.configFormDirty ? "Unsaved" : "Saved"}</span>
      </div>
      <div
        class="pill pill--sm ${
          state.configValid === true
            ? "pill--ok"
            : state.configValid === false
              ? "pill--danger"
              : ""
        }"
      >
        <span>Config</span>
        <span class="mono"
          >${state.configValid == null ? "Unknown" : state.configValid ? "Valid" : "Invalid"}</span
        >
      </div>
      ${state.lastError ? html`<div class="pill danger">${state.lastError}</div>` : nothing}
    </div>
  `;
}
