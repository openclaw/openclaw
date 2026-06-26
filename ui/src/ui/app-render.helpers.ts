// Control UI module implements app render behavior.
import { html, nothing } from "lit";
import { SUPPORTED_LOCALES, i18n, isSupportedLocale, t, type Locale } from "../i18n/index.ts";
import {
  createChatSessionsLoadOverrides,
  flushChatQueueAfterIdleSessionReconciliation,
  refreshChat,
  refreshChatAvatar,
  scopedAgentParamsForSession,
  scopedAgentListParamsForSession,
} from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { persistChatComposerState, restoreChatComposerState } from "./chat/composer-persistence.ts";
import { reconcileChatRunLifecycle } from "./chat/run-lifecycle.ts";
import {
  renderChatSessionSelect as renderChatSessionSelectBase,
  renderChatModelSelect,
  renderChatQuotaPill,
  resetChatSessionPickerState,
  resolveSessionOptionGroups,
} from "./chat/session-controls.ts";
import { cacheChatMessages, readChatMessagesFromCache } from "./chat/session-message-cache.ts";
import { refreshSlashCommands } from "./chat/slash-commands.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import type { ChatState } from "./controllers/chat.ts";
import {
  attachSessionToProject,
  loadProjects,
  projectDocumentIdsFromMetadata,
  projectMetadataWithDocumentIds,
  resetCurrentSessionProjectChatDraft,
  saveCurrentSessionProjectChat,
  selectProject,
  syncProjectSelectionForSession,
} from "./controllers/projects.ts";
import {
  createSessionAndRefresh,
  loadSessions,
  syncSelectedSessionMessageSubscription,
} from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, isSettingsTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import { projectUiText as p } from "./project-i18n.ts";
import { isCronSessionKey, parseSessionKey, resolveSessionDisplayName } from "./session-display.ts";
import {
  isSessionKeyTiedToAgent,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "./session-key.ts";
import { normalizeChatAutoScrollMode, type ChatAutoScrollMode } from "./storage.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-coerce.ts";
import type { ThemeMode } from "./theme.ts";
import type { SessionsListResult } from "./types.ts";
import type { ChatQueueItem } from "./ui-types.ts";

export { isCronSessionKey, parseSessionKey, resolveSessionDisplayName, resolveSessionOptionGroups };

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

type SessionSwitchHost = AppViewState & {
  chatStreamStartedAt: number | null;
  chatSideResultTerminalRuns: Set<string>;
  resetChatInputHistoryNavigation(): void;
  resetToolStream(): void;
  resetChatScroll(): void;
};

type ChatRefreshHost = AppViewState & {
  chatManualRefreshInFlight: boolean;
  chatNewMessagesBelow: boolean;
  resetToolStream(): void;
  scrollToBottom(opts?: { smooth?: boolean }): void;
  updateComplete?: Promise<unknown>;
};

export async function handleChatManualRefresh(state: ChatRefreshHost): Promise<void> {
  state.chatManualRefreshInFlight = true;
  state.chatNewMessagesBelow = false;
  await state.updateComplete;
  state.resetToolStream();
  try {
    await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
      awaitHistory: true,
      scheduleScroll: false,
    });
    state.scrollToBottom({ smooth: true });
  } finally {
    requestAnimationFrame(() => {
      state.chatManualRefreshInFlight = false;
      state.chatNewMessagesBelow = false;
    });
  }
}

export function resolveAssistantAttachmentAuthToken(
  state: Pick<AppViewState, "hello" | "settings" | "password">,
) {
  return resolveControlUiAuthToken(state);
}

export function resolveDashboardHeaderContext(
  state: Pick<AppViewState, "agentsList" | "sessionKey">,
): { agentLabel: string } {
  const agentId = resolveAgentIdFromSessionKey(state.sessionKey);
  const agent = state.agentsList?.agents.find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === agentId,
  );
  const agentLabel =
    normalizeOptionalString(agent?.identity?.name) ??
    normalizeOptionalString(agent?.name) ??
    agentId;
  return { agentLabel };
}

function resolveSidebarChatSessionKey(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = normalizeOptionalString(snapshot?.sessionDefaults?.mainSessionKey);
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = normalizeOptionalString(snapshot?.sessionDefaults?.mainKey);
  if (mainKey) {
    return mainKey;
  }
  return "main";
}

function saveChatQueueForSession(state: AppViewState, sessionKey: string) {
  const queueBySession = (state.chatQueueBySession ??= {});
  if (state.chatQueue.length > 0) {
    queueBySession[sessionKey] = [...state.chatQueue];
    state.chatQueueBySession = { ...queueBySession };
    return;
  }
  if (Object.hasOwn(queueBySession, sessionKey)) {
    delete queueBySession[sessionKey];
    state.chatQueueBySession = { ...queueBySession };
  }
}

function restoreChatQueueForSession(state: AppViewState, sessionKey: string): ChatQueueItem[] {
  return [...(state.chatQueueBySession?.[sessionKey] ?? [])];
}

function chatMessageCacheForState(state: AppViewState) {
  return (state.chatMessagesBySession ??= new Map());
}

function saveChatMessagesForSession(state: AppViewState, sessionKey: string) {
  cacheChatMessages(chatMessageCacheForState(state), state, { sessionKey }, state.chatMessages);
}

function restoreChatMessagesForSession(state: AppViewState, sessionKey: string): unknown[] {
  return readChatMessagesFromCache(chatMessageCacheForState(state), state, { sessionKey });
}

function resetChatStateForSessionSwitch(state: AppViewState, sessionKey: string) {
  const host = state as unknown as SessionSwitchHost;
  const previousSessionKey = state.sessionKey;
  persistChatComposerState(state, previousSessionKey);
  saveChatQueueForSession(state, previousSessionKey);
  saveChatMessagesForSession(state, previousSessionKey);
  state.sessionKey = sessionKey;
  if (previousSessionKey !== sessionKey) {
    resetChatSessionPickerState(state);
  }
  const chatSessionState = state as unknown as {
    currentSessionId?: string | null;
    reconnectResumeSessionId?: string | null;
  };
  chatSessionState.currentSessionId = null;
  chatSessionState.reconnectResumeSessionId = null;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatMessages = restoreChatMessagesForSession(state, sessionKey);
  state.chatToolMessages = [];
  state.activityEntries = [];
  state.activityExpandedIds = new Set();
  state.activityAtBottom = true;
  state.chatStreamSegments = [];
  state.chatThinkingLevel = null;
  state.chatStream = null;
  state.chatSideResult = null;
  state.lastError = null;
  state.chatError = null;
  state.chatAvatarUrl = null;
  state.chatAvatarSource = null;
  state.chatAvatarStatus = null;
  state.chatAvatarReason = null;
  state.realtimeTalkTranscript = null;
  state.resetRealtimeTalkConversation?.();
  state.chatQueue = restoreChatQueueForSession(state, sessionKey);
  restoreChatComposerState(state);
  host.resetChatInputHistoryNavigation();
  host.chatStreamStartedAt = null;
  reconcileChatRunLifecycle(state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
    clearLocalRun: true,
    clearChatStream: true,
    clearToolStream: true,
    clearSideResultTerminalRuns: true,
    clearRunStatus: true,
  });
  host.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

function canSwitchToNewChatSession(state: AppViewState): boolean {
  return (
    !state.chatLoading &&
    !state.chatSending &&
    !state.chatRunId &&
    state.chatStream === null &&
    state.chatQueue.length === 0
  );
}

const NEW_CHAT_ACTIVE_RUN_MESSAGE =
  "Start a new session after the active run or queued messages finish.";
const NEW_CHAT_SESSIONS_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
const NEW_CHAT_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new session. Try again in a moment.";
const NEW_CHAT_PROJECT_ATTACH_FAILED_MESSAGE =
  "New session was created, but it could not be linked to the active project.";

export function renderTab(state: AppViewState, tab: Tab, opts?: { collapsed?: boolean }) {
  const href = pathForTab(tab, state.basePath);
  const isActive = tab === "config" ? isSettingsTab(state.tab) : state.tab === tab;
  const collapsed = opts?.collapsed ?? state.settings.navCollapsed;
  return html`
    <a
      href=${href}
      class="nav-item ${isActive ? "nav-item--active" : ""}"
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
        if (tab === "chat") {
          if (!state.sessionKey) {
            const mainSessionKey = resolveSidebarChatSessionKey(state);
            resetChatStateForSessionSwitch(state, mainSessionKey);
          }
          if (state.tab !== "chat") {
            void state.loadAssistantIdentity();
          }
        }
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      ${!collapsed ? html`<span class="nav-item__text">${titleForTab(tab)}</span>` : nothing}
    </a>
  `;
}

function renderCronFilterIcon(hiddenCount: number) {
  return html`
    <span style="position: relative; display: inline-flex; align-items: center;">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
      ${hiddenCount > 0
        ? html`<span
            style="
              position: absolute;
              top: -5px;
              right: -6px;
              background: var(--color-accent, #6366f1);
              color: #fff;
              border-radius: var(--radius-full);
              font-size: 9px;
              line-height: 1;
              padding: 1px 3px;
              pointer-events: none;
            "
            >${hiddenCount}</span
          >`
        : ""}
    </span>
  `;
}

export function renderChatSessionSelect(state: AppViewState) {
  return renderChatSessionSelectBase(state, switchChatSession, { surface: "desktop" });
}

function chatAutoScrollLabel(mode: ChatAutoScrollMode) {
  switch (mode) {
    case "always":
      return t("chat.autoScrollAlways");
    case "off":
      return t("chat.autoScrollOff");
    case "near-bottom":
      return t("chat.autoScrollNearBottom");
  }
  return t("chat.autoScrollNearBottom");
}

function nextChatAutoScrollMode(mode: ChatAutoScrollMode): ChatAutoScrollMode {
  switch (mode) {
    case "near-bottom":
      return "always";
    case "always":
      return "off";
    case "off":
      return "near-bottom";
  }
  return "near-bottom";
}

function renderChatAutoScrollToggle(state: AppViewState, options: { labelled?: boolean } = {}) {
  const mode = normalizeChatAutoScrollMode(state.settings.chatAutoScroll);
  const label = `${t("chat.autoScrollMode")}: ${chatAutoScrollLabel(mode)}`;
  const active = mode !== "off";
  return html`
    <button
      class="btn btn--sm btn--icon ${options.labelled ? "chat-settings-action" : ""} ${active
        ? "active"
        : ""}"
      data-chat-auto-scroll-toggle="true"
      data-chat-auto-scroll-mode=${mode}
      data-tooltip=${label}
      aria-label=${label}
      aria-pressed=${active}
      title=${label}
      @click=${() => {
        state.applySettings({
          ...state.settings,
          chatAutoScroll: nextChatAutoScrollMode(mode),
        });
      }}
    >
      ${icons.scrollText}
      ${options.labelled
        ? html`<span class="chat-settings-action__text">${t("chat.autoScrollMode")}</span>`
        : ""}
    </button>
  `;
}

export function renderChatControls(state: AppViewState) {
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(state, state.sessionsResult) : 0;
  const disableThinkingToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const thinkingLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.thinkingToggle");
  const toolCallsLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.toolCallsToggle");
  const refreshDisabled =
    !state.connected ||
    state.chatManualRefreshInFlight ||
    state.chatLoading ||
    state.chatSending ||
    state.chatStream !== null ||
    Boolean(state.chatRunId);
  const cronLabel = hideCron
    ? hiddenCronCount > 0
      ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
      : t("chat.showCronSessions")
    : t("chat.hideCronSessions");
  const toolCallsIcon = html`
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
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;
  const settingsOpen = state.chatMobileControlsOpen;
  const settingsLabel = t("chat.settings");
  const settingsTitle = t("chat.settings");

  return html`
    <div
      class="chat-composer-model-control"
      @click=${() => {
        if (state.chatMobileControlsOpen) {
          state.setChatMobileControlsOpen(false);
        }
      }}
    >
      ${renderChatModelSelect(state)}
    </div>
    ${renderChatProjectSelect(state)} ${renderChatProjectRoleSelect(state)}
    ${renderChatProjectDocumentSelect(state)} ${renderActiveProjectChatTitleEdit(state)}
    ${renderSaveCurrentProjectChatButton(state)} ${renderChatQuotaPill(state)}
    <div class="chat-settings-popover-wrapper">
      <button
        class="chat-settings-chip ${settingsOpen ? "chat-settings-chip--open" : ""}"
        type="button"
        title=${settingsTitle}
        aria-label=${settingsTitle}
        aria-expanded=${settingsOpen}
        aria-controls="chat-composer-settings-popover"
        @click=${(e: Event) => {
          e.stopPropagation();
          (e.currentTarget as HTMLElement)
            .closest(".agent-chat__composer-controls")
            ?.querySelectorAll("details.chat-controls__inline-select[open]")
            .forEach((details) => details.removeAttribute("open"));
          state.setChatMobileControlsOpen(!settingsOpen, {
            trigger: e.currentTarget as HTMLElement,
          });
        }}
      >
        <span class="chat-settings-chip__icon">${icons.settings}</span>
        <span class="chat-settings-chip__text">${settingsLabel}</span>
        <span class="chat-settings-chip__chevron">${icons.chevronDown}</span>
      </button>
      <div
        id="chat-composer-settings-popover"
        class="chat-settings-popover ${settingsOpen ? "chat-settings-popover--open" : ""}"
        role="dialog"
        aria-label=${settingsTitle}
      >
        <div class="chat-settings-popover__section">
          <span class="chat-settings-popover__label">${settingsLabel}</span>
          <div class="chat-settings-popover__toggles">
            <button
              class="btn btn--sm btn--icon chat-settings-action"
              ?disabled=${refreshDisabled}
              @click=${() => {
                if (!refreshDisabled) {
                  void handleChatManualRefresh(state as ChatRefreshHost);
                }
              }}
              title=${t("common.refresh")}
              aria-label=${t("common.refresh")}
              data-tooltip=${t("common.refresh")}
            >
              ${icons.refresh}
              <span class="chat-settings-action__text">${t("common.refresh")}</span>
            </button>
            ${renderChatAutoScrollToggle(state, { labelled: true })}
            <button
              class="btn btn--sm btn--icon chat-settings-action ${showThinking ? "active" : ""}"
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
              title=${thinkingLabel}
              aria-label=${thinkingLabel}
              data-tooltip=${thinkingLabel}
            >
              ${icons.brain}
              <span class="chat-settings-action__text">${t("cron.form.thinking")}</span>
            </button>
            <button
              class="btn btn--sm btn--icon chat-settings-action ${showToolCalls ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (disableThinkingToggle) {
                  return;
                }
                state.applySettings({
                  ...state.settings,
                  chatShowToolCalls: !state.settings.chatShowToolCalls,
                });
              }}
              aria-pressed=${showToolCalls}
              title=${toolCallsLabel}
              aria-label=${toolCallsLabel}
              data-tooltip=${toolCallsLabel}
            >
              ${toolCallsIcon}
              <span class="chat-settings-action__text">${t("agents.tabs.tools")}</span>
            </button>
            <button
              class="btn btn--sm btn--icon chat-settings-action ${hideCron ? "active" : ""}"
              @click=${() => {
                state.sessionsHideCron = !hideCron;
              }}
              aria-pressed=${hideCron}
              title=${cronLabel}
              aria-label=${cronLabel}
              data-tooltip=${cronLabel}
            >
              ${renderCronFilterIcon(hiddenCronCount)}
              <span class="chat-settings-action__text">${t("cron.jobList.history")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderChatProjectSelect(state: AppViewState) {
  const projects = (state.projectsResult?.projects ?? []).filter(
    (project) => project.status === "active",
  );
  const selectedProject = projects.find(
    (project) => project.projectId === state.projectsSelectedId,
  );
  const disabled = !state.connected || !state.client || state.projectsLoading;
  const title = selectedProject ? `${p("projects")}: ${selectedProject.name}` : p("noProject");
  return html`
    <label class="chat-project-select" title=${title}>
      <span class="chat-project-select__icon" aria-hidden="true">${icons.folder}</span>
      <select
        class="chat-project-select__control"
        aria-label=${p("projects")}
        .value=${state.projectsSelectedId ?? ""}
        ?disabled=${disabled}
        @focus=${() => {
          if (!state.projectsResult && !state.projectsLoading) {
            void loadProjects(state, { preserveSelection: true });
          }
        }}
        @change=${(event: Event) => {
          const projectId = (event.target as HTMLSelectElement).value.trim();
          if (!projectId) {
            state.projectsSelectedId = null;
            state.projectActiveChat = null;
            state.projectChatDraftTitle = "";
            state.projectChatDraftRole = "";
            state.projectChatDraftDocumentIds = [];
            return;
          }
          void selectProject(state, projectId);
        }}
      >
        <option value="">${projects.length > 0 ? p("noProject") : p("noProjects")}</option>
        ${projects.map(
          (project) => html`<option value=${project.projectId}>${project.name}</option>`,
        )}
      </select>
    </label>
  `;
}

function activeProjectRoles(state: AppViewState) {
  return state.projectRoles.filter((role) => role.status === "active");
}

function renderChatProjectRoleSelect(state: AppViewState) {
  const selectedProjectId = normalizeOptionalString(state.projectsSelectedId);
  if (!selectedProjectId) {
    return nothing;
  }
  const roles = activeProjectRoles(state);
  const activeChat = state.projectActiveChat;
  const selectedProject =
    state.projectDetail?.projectId === selectedProjectId
      ? state.projectDetail
      : state.projectsResult?.projects.find((project) => project.projectId === selectedProjectId);
  const defaultRoleKey = selectedProject?.defaultRoleKey ?? "";
  const selectedRole = activeChat
    ? state.projectChatDraftRole
    : state.projectChatDraftRole || state.projectNewChatRole || defaultRoleKey;
  const selectedRoleName =
    roles.find((role) => role.roleKey === selectedRole)?.name ?? selectedRole;
  const title = activeChat
    ? selectedRoleName
      ? p("currentChatRole", { role: selectedRoleName })
      : p("currentChatNoRole")
    : selectedRoleName
      ? `New chat role: ${selectedRoleName}`
      : p("noRole");
  return html`
    <label class="chat-project-role-select" title=${title}>
      <span class="chat-project-role-select__label">${activeChat ? p("role") : p("newChat")}</span>
      <select
        class="chat-project-role-select__control"
        aria-label=${activeChat ? p("role") : p("newChat")}
        .value=${selectedRole}
        ?disabled=${!state.connected || !state.client || state.projectRolesLoading}
        @change=${(event: Event) => {
          const role = (event.target as HTMLSelectElement).value.trim();
          if (activeChat) {
            state.projectChatDraftRole = role;
            return;
          }
          state.projectChatDraftRole = role;
          state.projectNewChatRole = role;
        }}
      >
        <option value="">
          ${activeChat || !defaultRoleKey ? p("noRole") : p("projectDefault")}
        </option>
        ${roles.map((role) => html`<option value=${role.roleKey}>${role.name}</option>`)}
      </select>
    </label>
  `;
}

function renderChatProjectDocumentSelect(state: AppViewState) {
  const selectedProjectId = normalizeOptionalString(state.projectsSelectedId);
  if (!selectedProjectId) {
    return nothing;
  }
  const documents = state.projectDocuments.filter(
    (document) => document.status === "active" && document.includeInContext !== true,
  );
  if (documents.length === 0) {
    return nothing;
  }
  const activeChat = state.projectActiveChat;
  const selectedDocumentIds = activeChat
    ? state.projectChatDraftDocumentIds
    : state.projectChatDraftDocumentIds.length > 0
      ? state.projectChatDraftDocumentIds
      : state.projectNewChatDocumentIds;
  const selectedNames = documents
    .filter((document) => selectedDocumentIds.includes(document.documentId))
    .map((document) => document.title);
  const title =
    selectedNames.length > 0
      ? `${activeChat ? p("projectChats") : p("newChat")} ${p("documents")}: ${selectedNames.join(
          ", ",
        )}`
      : `${activeChat ? p("projectChats") : p("newChat")}: ${p("extraDocs")}`;
  return html`
    <label class="chat-project-doc-select" title=${title}>
      <span class="chat-project-doc-select__label"
        >${activeChat ? p("documents") : p("newChatDocs")}</span
      >
      <select
        class="chat-project-doc-select__control"
        aria-label=${activeChat ? p("documents") : p("newChatDocs")}
        multiple
        .value=${selectedDocumentIds[0] ?? ""}
        ?disabled=${!state.connected || !state.client || state.projectDocumentsLoading}
        @change=${(event: Event) => {
          const selected = Array.from((event.target as HTMLSelectElement).selectedOptions).map(
            (option) => option.value,
          );
          if (activeChat) {
            state.projectChatDraftDocumentIds = selected;
            return;
          }
          state.projectChatDraftDocumentIds = selected;
          state.projectNewChatDocumentIds = selected;
        }}
      >
        ${documents.map(
          (document) => html`
            <option
              value=${document.documentId}
              ?selected=${selectedDocumentIds.includes(document.documentId)}
            >
              ${document.title}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

function renderActiveProjectChatTitleEdit(state: AppViewState) {
  const activeChat = state.projectActiveChat;
  if (!state.projectsSelectedId) {
    return nothing;
  }
  return html`
    <label
      class="chat-project-title-edit"
      title=${activeChat ? p("currentProjectChatTitle") : p("projectChatTitle")}
    >
      <span class="chat-project-title-edit__label">${p("title")}</span>
      <input
        class="chat-project-title-edit__control"
        aria-label=${p("currentProjectChatTitle")}
        type="text"
        .value=${state.projectChatDraftTitle}
        placeholder=${p("sessionTitle")}
        ?disabled=${!state.connected || !state.client || state.projectsSaving}
        @input=${(event: Event) => {
          state.projectChatDraftTitle = (event.target as HTMLInputElement).value;
        }}
      />
    </label>
  `;
}

function projectChatDraftIsDirty(state: AppViewState): boolean {
  const selectedProjectId = normalizeOptionalString(state.projectsSelectedId);
  if (!selectedProjectId) {
    return false;
  }
  const activeChat = state.projectActiveChat;
  if (!activeChat) {
    return true;
  }
  const title = normalizeOptionalString(state.projectChatDraftTitle) ?? "";
  const role = normalizeOptionalString(state.projectChatDraftRole) ?? "";
  const currentTitle = activeChat.title ?? "";
  const currentRole = activeChat.role ?? "";
  const currentDocumentIds = projectDocumentIdsFromMetadata(activeChat.metadata);
  const nextDocumentIds = state.projectChatDraftDocumentIds;
  return (
    title !== currentTitle ||
    role !== currentRole ||
    currentDocumentIds.join("\u0000") !== nextDocumentIds.join("\u0000")
  );
}

function renderSaveCurrentProjectChatButton(state: AppViewState) {
  if (!normalizeOptionalString(state.projectsSelectedId)) {
    return nothing;
  }
  const dirty = projectChatDraftIsDirty(state);
  const label = state.projectsSaving
    ? p("saving")
    : state.projectActiveChat
      ? p("save")
      : p("attach");
  const title = state.projectActiveChat
    ? dirty
      ? p("saveProjectChatChanges")
      : p("projectChatChangesSaved")
    : p("attach");
  return html`
    ${dirty
      ? html`<span class="chat-project-unsaved" role="status">${p("unsaved")}</span>`
      : nothing}
    ${dirty && state.projectActiveChat
      ? html`
          <button
            class="btn btn--sm chat-project-discard"
            type="button"
            title=${p("discard")}
            aria-label=${p("discard")}
            ?disabled=${!state.connected || !state.client || state.projectsSaving}
            @click=${() => resetCurrentSessionProjectChatDraft(state)}
          >
            ${icons.x}<span>${p("discard")}</span>
          </button>
        `
      : nothing}
    <button
      class="btn btn--sm chat-project-save ${dirty ? "chat-project-save--dirty" : ""}"
      type="button"
      title=${title}
      aria-label=${title}
      ?disabled=${!state.connected || !state.client || state.projectsSaving || !dirty}
      @click=${() => void saveCurrentSessionProjectChat(state)}
    >
      ${icons.check}<span>${label}</span>
    </button>
  `;
}

/**
 * Mobile-only gear toggle + dropdown for chat controls.
 * Rendered in the topbar so it doesn't consume content-header space.
 * Hidden on desktop via CSS.
 */
export function renderChatMobileToggle(state: AppViewState) {
  const controlsDropdownId = "chat-mobile-controls-dropdown";
  const mobileControlsOpen = state.chatMobileControlsOpen;
  const disableThinkingToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(state, state.sessionsResult) : 0;
  const toolCallsIcon = html`
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
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;

  return html`
    <div class="chat-mobile-controls-wrapper">
      <button
        class="btn btn--sm btn--icon chat-controls-mobile-toggle"
        @click=${(e: Event) => {
          e.stopPropagation();
          state.setChatMobileControlsOpen(!mobileControlsOpen, {
            trigger: e.currentTarget as HTMLElement,
          });
        }}
        title=${t("chat.settings")}
        aria-label=${t("chat.settings")}
        aria-expanded=${mobileControlsOpen}
        aria-controls=${controlsDropdownId}
      >
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
          <circle cx="12" cy="12" r="3"></circle>
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          ></path>
        </svg>
      </button>
      <div
        id=${controlsDropdownId}
        class="chat-controls-dropdown ${mobileControlsOpen ? "open" : ""}"
        @click=${(e: Event) => {
          e.stopPropagation();
        }}
      >
        <div class="chat-controls">
          ${renderChatSessionSelectBase(state, switchChatSession, { surface: "mobile" })}
          <div class="chat-controls__thinking">
            ${renderChatAutoScrollToggle(state)}
            <button
              class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowThinking: !state.settings.chatShowThinking,
                  });
                }
              }}
              aria-pressed=${showThinking}
              title=${t("chat.thinkingToggle")}
            >
              ${icons.brain}
            </button>
            <button
              class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowToolCalls: !state.settings.chatShowToolCalls,
                  });
                }
              }}
              aria-pressed=${showToolCalls}
              title=${t("chat.toolCallsToggle")}
            >
              ${toolCallsIcon}
            </button>
            <button
              class="btn btn--sm btn--icon ${hideCron ? "active" : ""}"
              @click=${() => {
                state.sessionsHideCron = !hideCron;
              }}
              aria-pressed=${hideCron}
              title=${hideCron
                ? hiddenCronCount > 0
                  ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
                  : t("chat.showCronSessions")
                : t("chat.hideCronSessions")}
            >
              ${renderCronFilterIcon(hiddenCronCount)}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function switchChatSessionInternal(
  state: AppViewState,
  nextSessionKey: string,
  opts?: { awaitInitialLoad?: boolean },
): Promise<void> | undefined {
  const previousSessionKey = state.sessionKey;
  const previousSessionsResult = state.sessionsResult;
  const nextSessionRow =
    state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey) ??
    state.chatSessionPickerResult?.sessions.find((row) => row.key === nextSessionKey);
  const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
  resetChatStateForSessionSwitch(state, nextSessionKey);
  if (previousSessionKey !== nextSessionKey) {
    state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
  }
  void state.loadAssistantIdentity();
  void refreshChatAvatar(state);
  void syncProjectSelectionForSession(state, nextSessionKey);
  void refreshSlashCommands({
    client: state.client,
    agentId: parseAgentSessionKey(nextSessionKey)?.agentId,
  });
  syncUrlWithSessionKey(
    state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
    nextSessionKey,
    true,
  );
  const subscriptionSync = syncSelectedSessionMessageSubscription(
    state as unknown as AppViewState & { chatSessionMessageSubscriptionKey?: string | null },
  );
  const historyLoad = loadChatHistory(state as unknown as ChatState);
  const sessionsRefresh = refreshSessionOptions(state);
  flushChatQueueAfterIdleSessionReconciliation(
    state as unknown as Parameters<typeof flushChatQueueAfterIdleSessionReconciliation>[0],
    nextSessionKey,
    historyLoad,
    sessionsRefresh,
    previousSessionsResult,
  );
  if (opts?.awaitInitialLoad) {
    void sessionsRefresh;
    return Promise.allSettled([subscriptionSync, historyLoad]).then(() => undefined);
  }
  void subscriptionSync;
  void historyLoad;
  void sessionsRefresh;
  return undefined;
}

export function switchChatSession(state: AppViewState, nextSessionKey: string): void {
  void switchChatSessionInternal(state, nextSessionKey);
}

export function switchChatSessionAndWait(
  state: AppViewState,
  nextSessionKey: string,
): Promise<void> {
  return (
    switchChatSessionInternal(state, nextSessionKey, { awaitInitialLoad: true }) ??
    Promise.resolve()
  );
}

export function dismissRealtimeTalkError(state: AppViewState) {
  if (state.realtimeTalkStatus !== "error") {
    return;
  }
  const talkHost = state as unknown as {
    realtimeTalkSession?: { stop(): void } | null;
  };
  talkHost.realtimeTalkSession?.stop();
  talkHost.realtimeTalkSession = null;
  state.realtimeTalkActive = false;
  state.realtimeTalkStatus = "idle";
  state.realtimeTalkDetail = null;
  state.realtimeTalkTranscript = null;
  state.resetRealtimeTalkConversation?.();
}

export function dismissChatError(state: AppViewState) {
  state.lastError = null;
  state.lastErrorCode = null;
  state.chatError = null;
}

export type CreateChatSessionIntent = {
  source: "user";
  projectChatRole?: string;
  projectChatTitle?: string;
};

export async function createChatSession(
  state: AppViewState,
  intent?: CreateChatSessionIntent,
): Promise<boolean> {
  if (intent?.source !== "user") {
    return false;
  }
  if (!state.client || !state.connected) {
    return false;
  }
  if (!canSwitchToNewChatSession(state)) {
    state.lastError = NEW_CHAT_ACTIVE_RUN_MESSAGE;
    state.chatError = state.lastError;
    return false;
  }
  if (state.sessionsLoading) {
    state.lastError = NEW_CHAT_SESSIONS_LOADING_MESSAGE;
    state.chatError = state.lastError;
    return false;
  }

  state.lastError = null;
  state.chatError = null;
  const previousSessionKey = state.sessionKey;
  const normalizedPreviousSessionKey = normalizeOptionalString(previousSessionKey);
  const parentSessionKey =
    normalizeLowercaseStringOrEmpty(normalizedPreviousSessionKey) === "unknown"
      ? undefined
      : normalizedPreviousSessionKey;
  const nextSessionKey = await createSessionAndRefresh(
    state as unknown as Parameters<typeof createSessionAndRefresh>[0],
    {
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
      parentSessionKey,
      emitCommandHooks: parentSessionKey !== undefined ? true : undefined,
    },
    {
      ...createChatSessionsLoadOverrides(state),
      ...scopedAgentListParamsForSession(state, previousSessionKey),
    },
  );
  if (
    !nextSessionKey ||
    state.sessionKey !== previousSessionKey ||
    !canSwitchToNewChatSession(state)
  ) {
    if (!nextSessionKey) {
      state.lastError =
        state.sessionsError ??
        (state.sessionsLoading
          ? NEW_CHAT_SESSIONS_LOADING_MESSAGE
          : NEW_CHAT_CREATE_FAILED_MESSAGE);
      state.chatError = state.lastError;
    }
    return false;
  }

  const preservedDraft = state.chatMessage;
  const preservedAttachments = state.chatAttachments;
  const activeProjectId = normalizeOptionalString(state.projectsSelectedId);
  if (activeProjectId) {
    const selectedProject =
      state.projectDetail?.projectId === activeProjectId
        ? state.projectDetail
        : state.projectsResult?.projects.find((project) => project.projectId === activeProjectId);
    const selectedRole =
      normalizeOptionalString(intent.projectChatRole) ??
      normalizeOptionalString(state.projectNewChatRole) ??
      normalizeOptionalString(selectedProject?.defaultRoleKey);
    const projectChatRole = normalizeOptionalString(selectedRole);
    const roleTitle = projectChatRole
      ? state.projectRoles.find((role) => role.roleKey === projectChatRole)?.name
      : undefined;
    const roleDocumentIds = projectChatRole
      ? projectDocumentIdsFromMetadata(
          state.projectRoles.find((role) => role.roleKey === projectChatRole)?.metadata,
        )
      : [];
    const selectedDocumentIds =
      state.projectNewChatDocumentIds.length > 0
        ? state.projectNewChatDocumentIds
        : roleDocumentIds;
    const metadata = projectMetadataWithDocumentIds(undefined, selectedDocumentIds) ?? undefined;
    try {
      await attachSessionToProject(state, {
        projectId: activeProjectId,
        sessionKey: nextSessionKey,
        title: intent.projectChatTitle ?? roleTitle,
        role: projectChatRole,
        metadata,
      });
      state.projectNewChatDocumentIds = [];
      void loadProjects(state, { preserveSelection: true });
    } catch {
      state.lastError = NEW_CHAT_PROJECT_ATTACH_FAILED_MESSAGE;
      state.chatError = state.lastError;
    }
  }
  switchChatSession(state, nextSessionKey);
  state.chatMessage = preservedDraft;
  state.chatAttachments = preservedAttachments;
  return true;
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    ...createChatSessionsLoadOverrides(state),
    ...scopedAgentListParamsForSession(state, state.sessionKey),
  });
}

/** Count cron sessions hidden by the active agent-scoped chat filter. */
function countHiddenCronSessions(state: AppViewState, sessions: SessionsListResult | null): number {
  if (!sessions?.sessions) {
    return 0;
  }
  const activeAgentId = normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ?? state.agentsList?.defaultId ?? "main",
  );
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");

  return sessions.sessions.filter(
    (s) =>
      isCronSessionKey(s.key) &&
      s.key !== state.sessionKey &&
      isSessionKeyTiedToAgent(s.key, activeAgentId, defaultAgentId),
  ).length;
}

type ThemeModeOption = { id: ThemeMode; labelKey: string; short: string };
const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  { id: "system", labelKey: "common.system", short: "SYS" },
  { id: "light", labelKey: "common.light", short: "LIGHT" },
  { id: "dark", labelKey: "common.dark", short: "DARK" },
];

export function renderTopbarThemeModeToggle(state: AppViewState) {
  const modeIcon = (mode: ThemeMode) => {
    if (mode === "system") {
      return icons.monitor;
    }
    if (mode === "light") {
      return icons.sun;
    }
    return icons.moon;
  };

  const applyMode = (mode: ThemeMode, e: Event) => {
    if (mode === state.themeMode) {
      return;
    }
    state.setThemeMode(mode, { element: e.currentTarget as HTMLElement });
  };

  return html`
    <div class="topbar-theme-mode" role="group" aria-label=${t("common.colorMode")}>
      ${THEME_MODE_OPTIONS.map((opt) => {
        // Group aria-label already says "Color mode"; per-button label only needs
        // the differentiating mode name (System/Light/Dark).
        const label = t(opt.labelKey);
        return html`
          <button
            type="button"
            class="topbar-theme-mode__btn ${opt.id === state.themeMode
              ? "topbar-theme-mode__btn--active"
              : ""}"
            title=${label}
            aria-label=${label}
            data-tooltip=${label}
            aria-pressed=${opt.id === state.themeMode}
            @click=${(e: Event) => applyMode(opt.id, e)}
          >
            ${modeIcon(opt.id)}
          </button>
        `;
      })}
    </div>
  `;
}

function languageKey(locale: Locale): string {
  return locale.replace(/-([a-zA-Z])/g, (_, c: string) => c.toUpperCase());
}

export function renderTopbarLanguageSelect(state: AppViewState) {
  const currentLocale = isSupportedLocale(state.settings.locale)
    ? state.settings.locale
    : i18n.getLocale();
  return html`
    <label class="topbar-language" title=${t("overview.access.language")}>
      <span class="topbar-language__icon" aria-hidden="true">${icons.globe}</span>
      <select
        class="topbar-language__control"
        aria-label=${t("overview.access.language")}
        .value=${currentLocale}
        @change=${(event: Event) => {
          const locale = (event.target as HTMLSelectElement).value as Locale;
          void i18n.setLocale(locale);
          state.applySettings({ ...state.settings, locale });
        }}
      >
        ${SUPPORTED_LOCALES.map(
          (locale) => html`
            <option value=${locale} ?selected=${currentLocale === locale}>
              ${t(`languages.${languageKey(locale)}`)}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

export function renderSidebarConnectionStatus(state: AppViewState) {
  const label = state.connected ? t("common.online") : t("common.offline");
  const toneClass = state.connected
    ? "sidebar-connection-status--online"
    : "sidebar-connection-status--offline";

  return html`
    <span
      class="sidebar-version__status ${toneClass}"
      role="img"
      aria-live="polite"
      aria-label=${t("chat.gatewayStatus", { status: label })}
      title=${t("chat.gatewayStatus", { status: label })}
    ></span>
  `;
}
