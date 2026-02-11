import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AppViewState } from "./app-view-state.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ThemeMode } from "./theme.ts";
import type { SessionsListResult } from "./types.ts";
import { refreshChat } from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import { OpenClawApp } from "./app.ts";
import { ChatState, loadChatHistory } from "./controllers/chat.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";

type LoopSpeed = "slow" | "normal" | "fast";

const LOOP_SPEED_KEY = "openclaw.loop.speed.v1";
const LOOP_BASE_EVERY_MS_KEY = "openclaw.loop.baseEveryMs.v1";

function readLoopSpeed(): LoopSpeed {
  if (typeof window === "undefined") {
    return "normal";
  }
  const raw = window.localStorage.getItem(LOOP_SPEED_KEY);
  return raw === "slow" || raw === "fast" || raw === "normal" ? raw : "normal";
}

function writeLoopSpeed(speed: LoopSpeed) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(LOOP_SPEED_KEY, speed);
}

function readBaseEveryMs(): Record<string, number> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(LOOP_BASE_EVERY_MS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeBaseEveryMs(map: Record<string, number>) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(LOOP_BASE_EVERY_MS_KEY, JSON.stringify(map));
}

async function applyLoopSpeed(state: AppViewState, speed: LoopSpeed) {
  if (!state.client) {
    return;
  }
  const factor = speed === "slow" ? 2 : speed === "fast" ? 0.5 : 1;
  const baseEveryMsByJobId = readBaseEveryMs();
  const list = (await state.client.request("cron.list", {
    includeDisabled: true,
  })) as { jobs?: Array<Record<string, unknown>> };
  const jobs = Array.isArray(list.jobs) ? list.jobs : [];

  for (const job of jobs) {
    const id = typeof job.id === "string" ? job.id : null;
    const schedule = (job.schedule as Record<string, unknown> | undefined) ?? null;
    if (!id || !schedule || schedule.kind !== "every") {
      continue;
    }
    const everyMs = typeof schedule.everyMs === "number" ? schedule.everyMs : null;
    if (!everyMs || !Number.isFinite(everyMs) || everyMs <= 0) {
      continue;
    }
    if (!baseEveryMsByJobId[id]) {
      baseEveryMsByJobId[id] = everyMs;
    }
    const base = baseEveryMsByJobId[id];
    const nextEveryMs = Math.max(60_000, Math.round(base * factor));
    if (nextEveryMs === everyMs) {
      continue;
    }
    await state.client.request("cron.update", {
      id,
      patch: {
        schedule: {
          ...schedule,
          everyMs: nextEveryMs,
        },
      },
    });
  }

  writeBaseEveryMs(baseEveryMsByJobId);
  writeLoopSpeed(speed);
  await state.loadCron();
}

async function pauseAllAgentLoops(state: AppViewState) {
  if (!state.client) {
    return;
  }
  const list = (await state.client.request("cron.list", {
    includeDisabled: true,
  })) as { jobs?: Array<Record<string, unknown>> };
  const jobs = Array.isArray(list.jobs) ? list.jobs : [];
  for (const job of jobs) {
    const id = typeof job.id === "string" ? job.id : null;
    if (!id) {
      continue;
    }
    const enabled = job.enabled !== false;
    if (!enabled) {
      continue;
    }
    await state.client.request("cron.update", { id, patch: { enabled: false } });
  }
  await state.loadCron();
}

async function haltAllAgents(state: AppViewState) {
  if (!state.client) {
    return;
  }
  await pauseAllAgentLoops(state);
  if (state.chatRunId) {
    await state.handleAbortChat();
  }
  const res = (await state.client.request("sessions.list", {
    includeUnknown: true,
    includeGlobal: true,
    limit: 500,
  })) as { sessions?: Array<{ key?: string; kind?: string }> };
  const rows = Array.isArray(res.sessions) ? res.sessions : [];
  const protectedKeys = new Set(["main", state.sessionKey]);
  for (const row of rows) {
    const key = typeof row.key === "string" ? row.key : "";
    if (!key || protectedKeys.has(key)) {
      continue;
    }
    if (row.kind === "session" || row.kind === "isolated") {
      await state.client.request("sessions.delete", { key, deleteTranscript: false });
    }
  }
  await state.handleSessionsLoad();
}

export function renderTab(state: AppViewState, tab: Tab) {
  const href = pathForTab(tab, state.basePath);
  return html`
    <a
      href=${href}
      class="nav-item ${state.tab === tab ? "active" : ""}"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      <span class="nav-item__text">${titleForTab(tab)}</span>
    </a>
  `;
}

export function renderChatControls(state: AppViewState) {
  const mainSessionKey = resolveMainSessionKey(state.hello, state.sessionsResult);
  const sessionOptions = resolveSessionOptions(
    state.sessionKey,
    state.sessionsResult,
    mainSessionKey,
  );
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  const loopSpeed = readLoopSpeed();
  // Refresh icon
  const refreshIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  return html`
    <div class="chat-controls">
      <label class="field chat-controls__session">
        <select
          .value=${state.sessionKey}
          ?disabled=${!state.connected}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            state.sessionKey = next;
            state.chatMessage = "";
            state.chatStream = null;
            (state as unknown as OpenClawApp).chatStreamStartedAt = null;
            state.chatRunId = null;
            (state as unknown as OpenClawApp).resetToolStream();
            (state as unknown as OpenClawApp).resetChatScroll();
            state.applySettings({
              ...state.settings,
              sessionKey: next,
              lastActiveSessionKey: next,
            });
            void state.loadAssistantIdentity();
            syncUrlWithSessionKey(
              state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
              next,
              true,
            );
            void loadChatHistory(state as unknown as ChatState);
          }}
        >
          ${repeat(
            sessionOptions,
            (entry) => entry.key,
            (entry) =>
              html`<option value=${entry.key}>
                ${entry.displayName ?? entry.key}
              </option>`,
          )}
        </select>
      </label>
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${state.chatLoading || !state.connected}
        @click=${async () => {
          const app = state as unknown as OpenClawApp;
          app.chatManualRefreshInFlight = true;
          app.chatNewMessagesBelow = false;
          await app.updateComplete;
          app.resetToolStream();
          try {
            await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
              scheduleScroll: false,
            });
            app.scrollToBottom({ smooth: true });
          } finally {
            requestAnimationFrame(() => {
              app.chatManualRefreshInFlight = false;
              app.chatNewMessagesBelow = false;
            });
          }
        }}
        title="Refresh chat data"
      >
        ${refreshIcon}
      </button>
      <span class="chat-controls__separator">|</span>
      <button
        class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${showThinking}
        title=${
          disableThinkingToggle
            ? "Disabled during onboarding"
            : "Toggle assistant thinking/working output"
        }
      >
        ${icons.brain}
      </button>
      <button
        class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
        ?disabled=${disableFocusToggle}
        @click=${() => {
          if (disableFocusToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatFocusMode: !state.settings.chatFocusMode,
          });
        }}
        aria-pressed=${focusActive}
        title=${
          disableFocusToggle
            ? "Disabled during onboarding"
            : "Toggle focus mode (hide sidebar + page header)"
        }
      >
        ${focusIcon}
      </button>
      <span class="chat-controls__separator">|</span>
      <label class="field chat-controls__session" title="Automation speed for recurring loops">
        <select
          .value=${loopSpeed}
          ?disabled=${!state.connected}
          @change=${async (e: Event) => {
            const next = (e.target as HTMLSelectElement).value as LoopSpeed;
            if (next !== "slow" && next !== "normal" && next !== "fast") {
              return;
            }
            try {
              await applyLoopSpeed(state, next);
            } catch (err) {
              state.lastError = `Failed to apply speed: ${String(err)}`;
            }
          }}
        >
          <option value="slow">Speed: Slow</option>
          <option value="normal">Speed: Normal</option>
          <option value="fast">Speed: Fast</option>
        </select>
      </label>
      <button
        class="btn btn--sm"
        ?disabled=${!state.connected}
        title="Pause agent loops (non-destructive)"
        @click=${async () => {
          if (!window.confirm("Pause all agent loops? This will disable cron jobs until resumed manually.")) {
            return;
          }
          try {
            await pauseAllAgentLoops(state);
          } catch (err) {
            state.lastError = `Pause failed: ${String(err)}`;
          }
        }}
      >
        Pause
      </button>
      <details class="emergency-glass" ?disabled=${!state.connected}>
        <summary class="btn btn--sm" title="Emergency controls (guarded)">🚨 Emergency</summary>
        <div style="margin-top: 8px;">
          <button
            class="btn btn--sm"
            ?disabled=${!state.connected}
            title="Emergency halt: pause loops + terminate active non-main sessions"
            @click=${async () => {
              if (!window.confirm("HALT all agents? This pauses loops and terminates active non-main sessions.")) {
                return;
              }
              try {
                await haltAllAgents(state);
              } catch (err) {
                state.lastError = `Halt failed: ${String(err)}`;
              }
            }}
          >
            Halt
          </button>
        </div>
      </details>
    </div>
  `;
}

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

function resolveMainSessionKey(
  hello: AppViewState["hello"],
  sessions: SessionsListResult | null,
): string | null {
  const snapshot = hello?.snapshot as { sessionDefaults?: SessionDefaultsSnapshot } | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = snapshot?.sessionDefaults?.mainKey?.trim();
  if (mainKey) {
    return mainKey;
  }
  if (sessions?.sessions?.some((row) => row.key === "main")) {
    return "main";
  }
  return null;
}

export function resolveSessionDisplayName(
  key: string,
  row?: SessionsListResult["sessions"][number],
) {
  const displayName = row?.displayName?.trim() || "";
  const label = row?.label?.trim() || "";
  if (displayName && displayName !== key) {
    return `${displayName} (${key})`;
  }
  if (label && label !== key) {
    return `${label} (${key})`;
  }
  return key;
}

function resolveSessionOptions(
  sessionKey: string,
  sessions: SessionsListResult | null,
  mainSessionKey?: string | null,
) {
  const seen = new Set<string>();
  const options: Array<{ key: string; displayName?: string }> = [];

  const resolvedMain = mainSessionKey && sessions?.sessions?.find((s) => s.key === mainSessionKey);
  const resolvedCurrent = sessions?.sessions?.find((s) => s.key === sessionKey);

  // Add main session key first
  if (mainSessionKey) {
    seen.add(mainSessionKey);
    options.push({
      key: mainSessionKey,
      displayName: resolveSessionDisplayName(mainSessionKey, resolvedMain || undefined),
    });
  }

  // Add current session key next
  if (!seen.has(sessionKey)) {
    seen.add(sessionKey);
    options.push({
      key: sessionKey,
      displayName: resolveSessionDisplayName(sessionKey, resolvedCurrent),
    });
  }

  // Add sessions from the result
  if (sessions?.sessions) {
    for (const s of sessions.sessions) {
      if (!seen.has(s.key)) {
        seen.add(s.key);
        options.push({
          key: s.key,
          displayName: resolveSessionDisplayName(s.key, s),
        });
      }
    }
  }

  return options;
}

const THEME_ORDER: ThemeMode[] = ["system", "light", "dark"];

export function renderThemeToggle(state: AppViewState) {
  const index = Math.max(0, THEME_ORDER.indexOf(state.theme));
  const applyTheme = (next: ThemeMode) => (event: MouseEvent) => {
    const element = event.currentTarget as HTMLElement;
    const context: ThemeTransitionContext = { element };
    if (event.clientX || event.clientY) {
      context.pointerClientX = event.clientX;
      context.pointerClientY = event.clientY;
    }
    state.setTheme(next, context);
  };

  return html`
    <div class="theme-toggle" style="--theme-index: ${index};">
      <div class="theme-toggle__track" role="group" aria-label="Theme">
        <span class="theme-toggle__indicator"></span>
        <button
          class="theme-toggle__button ${state.theme === "system" ? "active" : ""}"
          @click=${applyTheme("system")}
          aria-pressed=${state.theme === "system"}
          aria-label="System theme"
          title="System"
        >
          ${renderMonitorIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "light" ? "active" : ""}"
          @click=${applyTheme("light")}
          aria-pressed=${state.theme === "light"}
          aria-label="Light theme"
          title="Light"
        >
          ${renderSunIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "dark" ? "active" : ""}"
          @click=${applyTheme("dark")}
          aria-pressed=${state.theme === "dark"}
          aria-label="Dark theme"
          title="Dark"
        >
          ${renderMoonIcon()}
        </button>
      </div>
    </div>
  `;
}

function renderSunIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4"></circle>
      <path d="M12 2v2"></path>
      <path d="M12 20v2"></path>
      <path d="m4.93 4.93 1.41 1.41"></path>
      <path d="m17.66 17.66 1.41 1.41"></path>
      <path d="M2 12h2"></path>
      <path d="M20 12h2"></path>
      <path d="m6.34 17.66-1.41 1.41"></path>
      <path d="m19.07 4.93-1.41 1.41"></path>
    </svg>
  `;
}

function renderMoonIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      ></path>
    </svg>
  `;
}

function renderMonitorIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <line x1="8" x2="16" y1="21" y2="21"></line>
      <line x1="12" x2="12" y1="17" y2="21"></line>
    </svg>
  `;
}
