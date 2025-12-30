import { html, nothing } from "lit";

import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import {
  TAB_GROUPS,
  pathForTab,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation";
import type {
  ConfigSnapshot,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  PresenceEntry,
  ProvidersStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type { CronFormState, TelegramForm } from "./ui-types";
import { renderChat } from "./views/chat";
import { renderConfig } from "./views/config";
import { renderConnections } from "./views/connections";
import { renderCron } from "./views/cron";
import { renderDebug } from "./views/debug";
import { renderInstances } from "./views/instances";
import { renderNodes } from "./views/nodes";
import { renderOverview } from "./views/overview";
import { renderSessions } from "./views/sessions";
import { renderSkills } from "./views/skills";
import { loadProviders } from "./controllers/connections";
import { loadPresence } from "./controllers/presence";
import { loadSessions, patchSession } from "./controllers/sessions";
import {
  installSkill,
  loadSkills,
  saveSkillApiKey,
  updateSkillEdit,
  updateSkillEnabled,
} from "./controllers/skills";
import { loadNodes } from "./controllers/nodes";
import { loadChatHistory } from "./controllers/chat";
import { loadConfig, saveConfig } from "./controllers/config";
import { loadCronRuns, toggleCronJob, runCronJob, removeCronJob, addCronJob } from "./controllers/cron";
import { loadDebug, callDebugMethod } from "./controllers/debug";

export type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};

export type AppViewState = {
  settings: { gatewayUrl: string; token: string; sessionKey: string };
  password: string;
  tab: Tab;
  basePath: string;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  eventLog: EventLogEntry[];
  sessionKey: string;
  chatLoading: boolean;
  chatSending: boolean;
  chatMessage: string;
  chatMessages: unknown[];
  chatStream: string | null;
  chatRunId: string | null;
  chatThinkingLevel: string | null;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  configLoading: boolean;
  configRaw: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configSnapshot: ConfigSnapshot | null;
  providersLoading: boolean;
  providersSnapshot: ProvidersStatusSnapshot | null;
  providersError: string | null;
  providersLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  telegramForm: TelegramForm;
  telegramSaving: boolean;
  telegramTokenLocked: boolean;
  telegramConfigStatus: string | null;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  cronLoading: boolean;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronRunsJobId: string | null;
  cronRuns: CronRunLogEntry[];
  cronBusy: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsFilter: string;
  skillEdits: Record<string, string>;
  skillsBusyKey: string | null;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
  debugHeartbeat: unknown | null;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
  client: GatewayBrowserClient | null;
  connect: () => void;
  setTab: (tab: Tab) => void;
  applySettings: (next: AppViewState["settings"]) => void;
  loadOverview: () => Promise<void>;
  loadCron: () => Promise<void>;
  handleWhatsAppStart: (force: boolean) => Promise<void>;
  handleWhatsAppWait: () => Promise<void>;
  handleWhatsAppLogout: () => Promise<void>;
  handleTelegramSave: () => Promise<void>;
  handleSendChat: () => Promise<void>;
};

export function renderApp(state: AppViewState) {
  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;

  return html`
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-title">Clawdis Control</div>
          <div class="brand-sub">Gateway dashboard</div>
        </div>
        <div class="topbar-status">
          <div class="pill">
            <span class="statusDot ${state.connected ? "ok" : ""}"></span>
            <span>Health</span>
            <span class="mono">${state.connected ? "OK" : "Offline"}</span>
          </div>
        </div>
      </header>
      <aside class="nav">
        ${TAB_GROUPS.map(
          (group) => html`
            <div class="nav-group">
              <div class="nav-label">${group.label}</div>
              ${group.tabs.map((tab) => renderTab(state, tab))}
            </div>
          `,
        )}
      </aside>
      <main class="content">
        <section class="content-header">
          <div>
            <div class="page-title">${titleForTab(state.tab)}</div>
            <div class="page-sub">${subtitleForTab(state.tab)}</div>
          </div>
          <div class="page-meta">
            ${state.lastError
              ? html`<div class="pill danger">${state.lastError}</div>`
              : nothing}
          </div>
        </section>

        ${state.tab === "overview"
          ? renderOverview({
              connected: state.connected,
              hello: state.hello,
              settings: state.settings,
              password: state.password,
              lastError: state.lastError,
              presenceCount,
              sessionsCount,
              cronEnabled: state.cronStatus?.enabled ?? null,
              cronNext,
              lastProvidersRefresh: state.providersLastSuccess,
              onSettingsChange: (next) => state.applySettings(next),
              onPasswordChange: (next) => (state.password = next),
              onSessionKeyChange: (next) => {
                state.sessionKey = next;
                state.applySettings({ ...state.settings, sessionKey: next });
              },
              onRefresh: () => state.loadOverview(),
            })
          : nothing}

        ${state.tab === "connections"
          ? renderConnections({
              connected: state.connected,
              loading: state.providersLoading,
              snapshot: state.providersSnapshot,
              lastError: state.providersError,
              lastSuccessAt: state.providersLastSuccess,
              whatsappMessage: state.whatsappLoginMessage,
              whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
              whatsappConnected: state.whatsappLoginConnected,
              whatsappBusy: state.whatsappBusy,
              telegramForm: state.telegramForm,
              telegramTokenLocked: state.telegramTokenLocked,
              telegramSaving: state.telegramSaving,
              telegramStatus: state.telegramConfigStatus,
              onRefresh: (probe) => loadProviders(state, probe),
              onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
              onWhatsAppWait: () => state.handleWhatsAppWait(),
              onWhatsAppLogout: () => state.handleWhatsAppLogout(),
              onTelegramChange: (patch) => updateTelegramForm(state, patch),
              onTelegramSave: () => state.handleTelegramSave(),
            })
          : nothing}

        ${state.tab === "instances"
          ? renderInstances({
              loading: state.presenceLoading,
              entries: state.presenceEntries,
              lastError: state.presenceError,
              statusMessage: state.presenceStatus,
              onRefresh: () => loadPresence(state),
            })
          : nothing}

        ${state.tab === "sessions"
          ? renderSessions({
              loading: state.sessionsLoading,
              result: state.sessionsResult,
              error: state.sessionsError,
              activeMinutes: state.sessionsFilterActive,
              limit: state.sessionsFilterLimit,
              includeGlobal: state.sessionsIncludeGlobal,
              includeUnknown: state.sessionsIncludeUnknown,
              onFiltersChange: (next) => {
                state.sessionsFilterActive = next.activeMinutes;
                state.sessionsFilterLimit = next.limit;
                state.sessionsIncludeGlobal = next.includeGlobal;
                state.sessionsIncludeUnknown = next.includeUnknown;
              },
              onRefresh: () => loadSessions(state),
              onPatch: (key, patch) => patchSession(state, key, patch),
            })
          : nothing}

        ${state.tab === "cron"
          ? renderCron({
              loading: state.cronLoading,
              status: state.cronStatus,
              jobs: state.cronJobs,
              error: state.cronError,
              busy: state.cronBusy,
              form: state.cronForm,
              runsJobId: state.cronRunsJobId,
              runs: state.cronRuns,
              onFormChange: (patch) => (state.cronForm = { ...state.cronForm, ...patch }),
              onRefresh: () => state.loadCron(),
              onAdd: () => addCronJob(state),
              onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
              onRun: (job) => runCronJob(state, job),
              onRemove: (job) => removeCronJob(state, job),
              onLoadRuns: (jobId) => loadCronRuns(state, jobId),
            })
          : nothing}

        ${state.tab === "skills"
          ? renderSkills({
              loading: state.skillsLoading,
              report: state.skillsReport,
              error: state.skillsError,
              filter: state.skillsFilter,
              edits: state.skillEdits,
              busyKey: state.skillsBusyKey,
              onFilterChange: (next) => (state.skillsFilter = next),
              onRefresh: () => loadSkills(state),
              onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
              onEdit: (key, value) => updateSkillEdit(state, key, value),
              onSaveKey: (key) => saveSkillApiKey(state, key),
              onInstall: (name, installId) => installSkill(state, name, installId),
            })
          : nothing}

        ${state.tab === "nodes"
          ? renderNodes({
              loading: state.nodesLoading,
              nodes: state.nodes,
              onRefresh: () => loadNodes(state),
            })
          : nothing}

        ${state.tab === "chat"
          ? renderChat({
              sessionKey: state.sessionKey,
              onSessionKeyChange: (next) => {
                state.sessionKey = next;
                state.applySettings({ ...state.settings, sessionKey: next });
              },
              thinkingLevel: state.chatThinkingLevel,
              loading: state.chatLoading,
              sending: state.chatSending,
              messages: state.chatMessages,
              stream: state.chatStream,
              draft: state.chatMessage,
              connected: state.connected,
              onRefresh: () => loadChatHistory(state),
              onDraftChange: (next) => (state.chatMessage = next),
              onSend: () => state.handleSendChat(),
            })
          : nothing}

        ${state.tab === "config"
          ? renderConfig({
              raw: state.configRaw,
              valid: state.configValid,
              issues: state.configIssues,
              loading: state.configLoading,
              saving: state.configSaving,
              connected: state.connected,
              onRawChange: (next) => (state.configRaw = next),
              onReload: () => loadConfig(state),
              onSave: () => saveConfig(state),
            })
          : nothing}

        ${state.tab === "debug"
          ? renderDebug({
              loading: state.debugLoading,
              status: state.debugStatus,
              health: state.debugHealth,
              models: state.debugModels,
              heartbeat: state.debugHeartbeat,
              eventLog: state.eventLog,
              callMethod: state.debugCallMethod,
              callParams: state.debugCallParams,
              callResult: state.debugCallResult,
              callError: state.debugCallError,
              onCallMethodChange: (next) => (state.debugCallMethod = next),
              onCallParamsChange: (next) => (state.debugCallParams = next),
              onRefresh: () => loadDebug(state),
              onCall: () => callDebugMethod(state),
            })
          : nothing}
      </main>
    </div>
  `;
}

function renderTab(state: AppViewState, tab: Tab) {
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
    >
      <span>${titleForTab(tab)}</span>
    </a>
  `;
}
