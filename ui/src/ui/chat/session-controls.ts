import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import { createChatSessionsLoadOverrides } from "../app-chat.ts";
import type { AppViewState } from "../app-view-state.ts";
import { createChatModelOverride } from "../chat-model-ref.ts";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "../chat-model-select-state.ts";
import { refreshVisibleToolsEffectiveForCurrentSession } from "../controllers/agents.ts";
import { loadSessions } from "../controllers/sessions.ts";
import { icons } from "../icons.ts";
import { isMonitoredAuthProvider } from "../model-auth-helpers.ts";
import { pathForTab } from "../navigation.ts";
import { collectQuotaWindowsFromAuthStatus, formatQuotaReset } from "../provider-quota-summary.ts";
import { pushUniqueTrimmedSelectOption } from "../select-options.ts";
import { isCronSessionKey, resolveSessionDisplayName } from "../session-display.ts";
import {
  buildAgentMainSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../session-key.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import {
  formatInheritedThinkingLabel,
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
} from "../thinking-labels.ts";
import {
  type ThinkingCatalogEntry,
  listThinkingLevelLabels,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} from "../thinking.ts";
import type { GatewayThinkingLevelOption, SessionsListResult } from "../types.ts";

type ChatSessionSwitchHandler = (state: AppViewState, nextSessionKey: string) => void;
type ChatSessionSelectSurface = "desktop" | "mobile";
type ChatSessionPickerSearchController = {
  activeRequestId: number | null;
  activeRequestSignature: string | null;
  nextRequestId: number;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
};

const CHAT_SESSION_PICKER_SEARCH_DEBOUNCE_MS = 300;
const chatSessionPickerSearchControllers = new WeakMap<
  AppViewState,
  ChatSessionPickerSearchController
>();

export function renderChatSessionSelect(
  state: AppViewState,
  onSwitchSession: ChatSessionSwitchHandler = () => undefined,
  options: { surface?: ChatSessionSelectSurface } = {},
) {
  const sessionGroups = resolveSessionOptionGroups(state, state.sessionKey, state.sessionsResult);
  const agentOptions = resolveChatAgentFilterOptions(state);
  const hasAgentSelect = agentOptions.length > 1;
  const agentSelect = renderChatAgentSelect(state, onSwitchSession, agentOptions);
  const modelSelect = renderChatModelSelect(state);
  const thinkingSelect = renderChatThinkingSelect(state);
  const quotaPill = renderChatQuotaPill(state);
  const surface = options.surface ?? "desktop";
  const selectedSessionLabel = resolveSelectedChatSessionLabel(state, sessionGroups);
  const pickerOpen = state.chatSessionPickerOpen && state.chatSessionPickerSurface === surface;
  const flashSession = state.sessionSwitchFlashKey === state.sessionKey;
  const rowClass = [
    "chat-controls__session-row",
    hasAgentSelect ? "" : "chat-controls__session-row--single-agent",
    quotaPill ? "chat-controls__session-row--has-quota" : "",
    flashSession ? "chat-controls__session-row--flash" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${rowClass}>
      ${agentSelect}
      ${renderChatSessionPicker({
        state,
        onSwitchSession,
        surface,
        selectedSessionLabel,
        pickerOpen,
        disabled: !state.connected || !state.client,
      })}
      ${modelSelect} ${thinkingSelect} ${quotaPill}
    </div>
    <div class="chat-controls__session-notice" role="status" aria-live="polite">
      ${state.sessionSwitchNotice?.text ?? ""}
    </div>
  `;
}

function resolveNextChatSessionOffset(
  sessions: SessionsListResult | null | undefined,
): number | null {
  if (!sessions?.hasMore) {
    return null;
  }
  if (typeof sessions.nextOffset === "number" && Number.isFinite(sessions.nextOffset)) {
    return Math.max(0, Math.floor(sessions.nextOffset));
  }
  return sessions.sessions.length;
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    ...createChatSessionsLoadOverrides(state),
  });
}

function requestHostUpdate(state: AppViewState) {
  (state as AppViewState & { requestUpdate?: () => void }).requestUpdate?.();
}

function getChatSessionPickerSearchController(
  state: AppViewState,
): ChatSessionPickerSearchController {
  let controller = chatSessionPickerSearchControllers.get(state);
  if (!controller) {
    controller = {
      activeRequestId: null,
      activeRequestSignature: null,
      nextRequestId: 0,
      timer: null,
    };
    chatSessionPickerSearchControllers.set(state, controller);
  }
  return controller;
}

function clearChatSessionPickerSearchTimer(state: AppViewState) {
  const controller = getChatSessionPickerSearchController(state);
  if (controller.timer) {
    globalThis.clearTimeout(controller.timer);
    controller.timer = null;
  }
}

function invalidateChatSessionPickerSearchRequests(state: AppViewState) {
  const controller = getChatSessionPickerSearchController(state);
  controller.nextRequestId += 1;
  controller.activeRequestId = null;
  controller.activeRequestSignature = null;
}

function beginChatSessionPickerSearchRequest(
  state: AppViewState,
  signature: string,
): number | null {
  const controller = getChatSessionPickerSearchController(state);
  if (controller.activeRequestSignature === signature) {
    return null;
  }
  controller.nextRequestId += 1;
  controller.activeRequestId = controller.nextRequestId;
  controller.activeRequestSignature = signature;
  return controller.activeRequestId;
}

function isCurrentChatSessionPickerSearchRequest(state: AppViewState, requestId: number): boolean {
  return getChatSessionPickerSearchController(state).activeRequestId === requestId;
}

function finishChatSessionPickerSearchRequest(state: AppViewState, requestId: number) {
  if (!isCurrentChatSessionPickerSearchRequest(state, requestId)) {
    return;
  }
  const controller = getChatSessionPickerSearchController(state);
  controller.activeRequestId = null;
  controller.activeRequestSignature = null;
}

function createChatSessionPickerRequestSignature(options: {
  append?: boolean;
  offset?: number;
  query: string;
}) {
  return [
    options.query,
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0,
    options.append === true ? "append" : "replace",
  ].join("\n");
}

function focusChatSessionPickerSearch(state: AppViewState) {
  const updateComplete = (state as AppViewState & { updateComplete?: Promise<unknown> })
    .updateComplete;
  const focus = () => {
    document.querySelector<HTMLInputElement>('[data-chat-session-picker-search="true"]')?.focus();
  };
  if (updateComplete) {
    void updateComplete.then(focus);
    return;
  }
  setTimeout(focus, 0);
}

function openChatSessionPicker(state: AppViewState, surface: ChatSessionSelectSurface) {
  state.chatSessionPickerOpen = true;
  state.chatSessionPickerSurface = surface;
  state.chatSessionPickerError = null;
  if (!state.chatSessionPickerResult && !state.chatSessionPickerAppliedQuery) {
    void loadChatSessionPickerPage(state);
  }
  requestHostUpdate(state);
  focusChatSessionPickerSearch(state);
}

function closeChatSessionPicker(state: AppViewState) {
  clearChatSessionPickerSearchTimer(state);
  state.chatSessionPickerOpen = false;
  state.chatSessionPickerSurface = null;
  requestHostUpdate(state);
}

export function resetChatSessionPickerState(state: AppViewState) {
  clearChatSessionPickerSearchTimer(state);
  invalidateChatSessionPickerSearchRequests(state);
  state.chatSessionPickerOpen = false;
  state.chatSessionPickerSurface = null;
  state.chatSessionPickerQuery = "";
  state.chatSessionPickerAppliedQuery = "";
  state.chatSessionPickerLoading = false;
  state.chatSessionPickerError = null;
  state.chatSessionPickerResult = null;
}

function toggleChatSessionPicker(state: AppViewState, surface: ChatSessionSelectSurface) {
  if (state.chatSessionPickerOpen && state.chatSessionPickerSurface === surface) {
    closeChatSessionPicker(state);
    return;
  }
  openChatSessionPicker(state, surface);
}

function createChatSessionPickerRequestParams(
  state: AppViewState,
  options: { query?: string; offset?: number } = {},
): Record<string, unknown> {
  const overrides = createChatSessionsLoadOverrides(state, {
    search: options.query,
    offset: options.offset,
  });
  const params: Record<string, unknown> = {
    includeGlobal: overrides.includeGlobal,
    includeUnknown: overrides.includeUnknown,
    configuredAgentsOnly: overrides.configuredAgentsOnly,
    limit: overrides.limit,
  };
  const activeAgentSession = parseAgentSessionKey(state.sessionKey);
  const activeSessionRow = state.sessionsResult?.sessions.find(
    (row) => row.key === state.sessionKey,
  );
  const isGlobalScopeSession =
    activeSessionRow?.kind === "global" ||
    activeSessionRow?.kind === "unknown" ||
    state.sessionKey === "global" ||
    state.sessionKey === "unknown";
  if (activeAgentSession || !isGlobalScopeSession) {
    params.agentId = normalizeAgentId(
      activeAgentSession?.agentId ?? state.agentsList?.defaultId ?? "main",
    );
  }
  const offset =
    typeof overrides.offset === "number" && Number.isFinite(overrides.offset)
      ? Math.max(0, Math.floor(overrides.offset))
      : 0;
  if (offset > 0) {
    params.offset = offset;
  }
  const search = normalizeOptionalString(overrides.search ?? undefined);
  if (search) {
    params.search = search;
  }
  return params;
}

function projectChatSessionPickerResult(
  state: AppViewState,
  result: SessionsListResult,
): SessionsListResult {
  if (state.sessionsShowArchived) {
    return result;
  }
  const sessions = result.sessions.filter((row) => row.key && row.archived !== true);
  return {
    ...result,
    count: sessions.length,
    sessions,
  };
}

function appendChatSessionPickerResult(
  previous: SessionsListResult,
  page: SessionsListResult,
): SessionsListResult {
  const rowsByKey = new Map(previous.sessions.map((row) => [row.key, row] as const));
  const sessions = [...previous.sessions];
  for (const row of page.sessions) {
    if (rowsByKey.has(row.key)) {
      continue;
    }
    rowsByKey.set(row.key, row);
    sessions.push(row);
  }
  return {
    ...page,
    count: sessions.length,
    sessions,
    totalCount: page.totalCount ?? previous.totalCount,
  };
}

async function loadChatSessionPickerPage(
  state: AppViewState,
  options: { query?: string; offset?: number; append?: boolean } = {},
) {
  if (!state.client || !state.connected) {
    return;
  }
  const query = normalizeOptionalString(options.query ?? state.chatSessionPickerAppliedQuery) ?? "";
  const requestId = beginChatSessionPickerSearchRequest(
    state,
    createChatSessionPickerRequestSignature({
      append: options.append,
      offset: options.offset,
      query,
    }),
  );
  if (requestId === null) {
    return;
  }
  state.chatSessionPickerLoading = true;
  state.chatSessionPickerError = null;
  requestHostUpdate(state);
  try {
    const page = projectChatSessionPickerResult(
      state,
      await state.client.request<SessionsListResult>(
        "sessions.list",
        createChatSessionPickerRequestParams(state, { query, offset: options.offset }),
      ),
    );
    if (!isCurrentChatSessionPickerSearchRequest(state, requestId)) {
      return;
    }
    const previous = state.chatSessionPickerResult ?? state.sessionsResult;
    state.chatSessionPickerResult =
      options.append === true && previous ? appendChatSessionPickerResult(previous, page) : page;
    state.chatSessionPickerAppliedQuery = query;
  } catch (err) {
    if (!isCurrentChatSessionPickerSearchRequest(state, requestId)) {
      return;
    }
    state.chatSessionPickerError = String(err);
  } finally {
    if (isCurrentChatSessionPickerSearchRequest(state, requestId)) {
      finishChatSessionPickerSearchRequest(state, requestId);
      state.chatSessionPickerLoading = false;
      requestHostUpdate(state);
    }
  }
}

async function applyChatSessionPickerSearch(state: AppViewState) {
  clearChatSessionPickerSearchTimer(state);
  const query = normalizeOptionalString(state.chatSessionPickerQuery) ?? "";
  if (!query) {
    clearChatSessionPickerSearch(state);
    return;
  }
  if (query === state.chatSessionPickerAppliedQuery && state.chatSessionPickerResult) {
    return;
  }
  await loadChatSessionPickerPage(state, { query });
}

function clearChatSessionPickerSearch(state: AppViewState, options: { focus?: boolean } = {}) {
  clearChatSessionPickerSearchTimer(state);
  invalidateChatSessionPickerSearchRequests(state);
  state.chatSessionPickerQuery = "";
  state.chatSessionPickerAppliedQuery = "";
  state.chatSessionPickerError = null;
  state.chatSessionPickerResult = null;
  state.chatSessionPickerLoading = false;
  requestHostUpdate(state);
  if (state.chatSessionPickerOpen) {
    void loadChatSessionPickerPage(state);
  }
  if (options.focus ?? true) {
    focusChatSessionPickerSearch(state);
  }
}

function scheduleChatSessionPickerSearch(state: AppViewState) {
  clearChatSessionPickerSearchTimer(state);
  const controller = getChatSessionPickerSearchController(state);
  controller.timer = globalThis.setTimeout(() => {
    controller.timer = null;
    void applyChatSessionPickerSearch(state);
  }, CHAT_SESSION_PICKER_SEARCH_DEBOUNCE_MS);
}

function updateChatSessionPickerSearchQuery(state: AppViewState, nextQuery: string) {
  state.chatSessionPickerQuery = nextQuery;
  const query = normalizeOptionalString(nextQuery) ?? "";
  if (!query) {
    clearChatSessionPickerSearch(state, { focus: false });
    return;
  }
  if (query !== state.chatSessionPickerAppliedQuery || !state.chatSessionPickerResult) {
    invalidateChatSessionPickerSearchRequests(state);
    state.chatSessionPickerError = null;
    state.chatSessionPickerLoading = false;
    scheduleChatSessionPickerSearch(state);
  } else {
    clearChatSessionPickerSearchTimer(state);
  }
  requestHostUpdate(state);
}

async function loadMoreChatSessionPickerResults(state: AppViewState) {
  const result = state.chatSessionPickerResult;
  const offset = resolveNextChatSessionOffset(result);
  if (offset === null) {
    return;
  }
  await loadChatSessionPickerPage(state, {
    query: state.chatSessionPickerAppliedQuery,
    offset,
    append: true,
  });
}

function resolveChatSessionRow(
  state: AppViewState,
  sessionKey: string,
): SessionsListResult["sessions"][number] | undefined {
  return (
    state.sessionsResult?.sessions.find((row) => row.key === sessionKey) ??
    state.chatSessionPickerResult?.sessions.find((row) => row.key === sessionKey)
  );
}

function resolveChatSessionPickerResult(state: AppViewState): SessionsListResult | null {
  if (
    state.chatSessionPickerResult ||
    state.chatSessionPickerAppliedQuery ||
    state.chatSessionPickerOpen
  ) {
    return state.chatSessionPickerResult;
  }
  return state.sessionsResult;
}

function resolveChatSessionPickerRows(
  state: AppViewState,
  result: SessionsListResult | null,
): { row: SessionsListResult["sessions"][number]; label: string }[] {
  const rowsByKey = new Map((result?.sessions ?? []).map((row) => [row.key, row] as const));
  return resolveSessionOptionGroups(state, state.sessionKey, result)
    .flatMap((group) => group.options)
    .filter((option) => rowsByKey.has(option.key))
    .map((option) => ({
      row: rowsByKey.get(option.key)!,
      label: option.label,
    }));
}

function resolveSelectedChatSessionLabel(
  state: AppViewState,
  sessionGroups: SessionOptionGroup[],
): string {
  const row = resolveChatSessionRow(state, state.sessionKey);
  const displayName = resolveSessionDisplayName(state.sessionKey, row);
  if (displayName !== state.sessionKey) {
    return displayName;
  }
  return (
    sessionGroups.flatMap((group) => group.options).find((entry) => entry.key === state.sessionKey)
      ?.label ?? state.sessionKey
  );
}

function formatChatSessionPickerMeta(row: SessionsListResult["sessions"][number]): string {
  const parts = [
    normalizeOptionalString(row.surface),
    [normalizeOptionalString(row.modelProvider), normalizeOptionalString(row.model)]
      .filter(Boolean)
      .join("/"),
  ].filter(Boolean);
  if (typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)) {
    parts.push(new Date(row.updatedAt).toLocaleString());
  }
  return parts.join(" · ");
}

function renderChatSessionPicker(params: {
  state: AppViewState;
  onSwitchSession: ChatSessionSwitchHandler;
  surface: ChatSessionSelectSurface;
  selectedSessionLabel: string;
  pickerOpen: boolean;
  disabled: boolean;
}) {
  const { state, onSwitchSession, surface, selectedSessionLabel, pickerOpen, disabled } = params;
  const pickerId = `chat-session-picker-${surface}`;
  return html`
    <div class="chat-controls__session chat-controls__session-picker">
      <button
        class="chat-controls__session-trigger"
        data-chat-session-select="true"
        type="button"
        title=${selectedSessionLabel}
        aria-label=${t("chat.selectors.session")}
        aria-haspopup="dialog"
        aria-expanded=${pickerOpen ? "true" : "false"}
        aria-controls=${pickerId}
        ?disabled=${disabled}
        @click=${() => toggleChatSessionPicker(state, surface)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openChatSessionPicker(state, surface);
          }
        }}
      >
        <span class="chat-controls__session-trigger-label">${selectedSessionLabel}</span>
        <span class="chat-controls__session-trigger-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </button>
      ${pickerOpen ? renderChatSessionPickerPopover(state, onSwitchSession, pickerId) : ""}
    </div>
  `;
}

function renderChatSessionPickerPopover(
  state: AppViewState,
  onSwitchSession: ChatSessionSwitchHandler,
  pickerId: string,
) {
  const result = resolveChatSessionPickerResult(state);
  const pickerRows = resolveChatSessionPickerRows(state, result);
  const controlsDisabled = !state.connected || !state.client;
  const normalizedQuery = normalizeOptionalString(state.chatSessionPickerQuery) ?? "";
  const searchPending = normalizedQuery !== state.chatSessionPickerAppliedQuery;
  const loadMoreDisabled = controlsDisabled || state.chatSessionPickerLoading || searchPending;
  const hasQuery =
    state.chatSessionPickerQuery.trim() !== "" || state.chatSessionPickerAppliedQuery.trim() !== "";
  const loadMoreOffset = resolveNextChatSessionOffset(result);
  const shownCount = pickerRows.length;
  const totalCount = result?.totalCount;
  const countLabel =
    typeof totalCount === "number" && Number.isFinite(totalCount)
      ? `${shownCount} / ${totalCount}`
      : String(shownCount);

  return html`
    <div
      id=${pickerId}
      class="chat-session-picker"
      role="dialog"
      aria-label=${t("chat.selectors.session")}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeChatSessionPicker(state);
        }
      }}
    >
      <div class="chat-session-picker__search-row">
        <label class="field chat-session-picker__search">
          <input
            data-chat-session-picker-search="true"
            type="search"
            placeholder=${t("chat.selectors.sessionSearch")}
            aria-label=${t("chat.selectors.sessionSearch")}
            .value=${state.chatSessionPickerQuery}
            ?disabled=${controlsDisabled}
            @input=${(event: Event) => {
              updateChatSessionPickerSearchQuery(state, (event.target as HTMLInputElement).value);
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void applyChatSessionPickerSearch(state);
              }
            }}
            @blur=${() => void applyChatSessionPickerSearch(state)}
          />
        </label>
        <button
          class="btn btn--ghost btn--icon chat-session-picker__icon-button"
          data-chat-session-search-submit="true"
          type="button"
          title=${t("common.search")}
          aria-label=${t("common.search")}
          ?disabled=${controlsDisabled}
          @click=${() => void applyChatSessionPickerSearch(state)}
        >
          ${icons.search}
        </button>
        ${hasQuery
          ? html`<button
              class="btn btn--ghost btn--icon chat-session-picker__icon-button"
              data-chat-session-search-clear="true"
              type="button"
              title=${t("chat.selectors.clearSessionSearch")}
              aria-label=${t("chat.selectors.clearSessionSearch")}
              ?disabled=${controlsDisabled}
              @click=${() => clearChatSessionPickerSearch(state)}
            >
              ${icons.x}
            </button>`
          : ""}
      </div>
      ${state.chatSessionPickerError
        ? html`<div class="chat-session-picker__status" role="alert">
            ${state.chatSessionPickerError}
          </div>`
        : ""}
      <div class="chat-session-picker__list" role="listbox">
        ${state.chatSessionPickerLoading && pickerRows.length === 0
          ? html`<div class="chat-session-picker__status">${t("common.loading")}</div>`
          : ""}
        ${!state.chatSessionPickerLoading && pickerRows.length === 0
          ? html`<div class="chat-session-picker__status">${t("sessionsView.noSessions")}</div>`
          : ""}
        ${repeat(
          pickerRows,
          (entry) => entry.row.key,
          (entry) => {
            const { row, label } = entry;
            const meta = formatChatSessionPickerMeta(row);
            const selected = row.key === state.sessionKey;
            return html`
              <button
                class="chat-session-picker__option ${selected
                  ? "chat-session-picker__option--selected"
                  : ""}"
                data-chat-session-picker-option="true"
                data-session-key=${row.key}
                role="option"
                aria-selected=${selected ? "true" : "false"}
                title=${label}
                type="button"
                @click=${() => {
                  closeChatSessionPicker(state);
                  if (row.key !== state.sessionKey) {
                    onSwitchSession(state, row.key);
                  }
                }}
              >
                <span class="chat-session-picker__option-main">
                  <span class="chat-session-picker__option-label">${label}</span>
                  ${meta ? html`<span class="chat-session-picker__option-meta">${meta}</span>` : ""}
                </span>
                ${selected
                  ? html`<span class="chat-session-picker__option-check" aria-hidden="true">
                      ${icons.check}
                    </span>`
                  : ""}
              </button>
            `;
          },
        )}
      </div>
      <div class="chat-session-picker__footer">
        <span class="chat-session-picker__count">${countLabel}</span>
        ${loadMoreOffset !== null
          ? html`<button
              class="btn btn--ghost btn--sm"
              data-chat-session-load-more="true"
              type="button"
              ?disabled=${loadMoreDisabled}
              @click=${() => void loadMoreChatSessionPickerResults(state)}
            >
              ${t("chat.selectors.loadMoreSessions")}
            </button>`
          : ""}
      </div>
    </div>
  `;
}

function renderChatQuotaPill(state: AppViewState) {
  const windows = collectQuotaWindowsFromAuthStatus(
    state.modelAuthStatusResult,
    isMonitoredAuthProvider,
  );
  const primary = windows[0];
  if (!primary) {
    return "";
  }
  const secondary = windows.find(
    (entry) => entry.displayName !== primary.displayName || entry.label !== primary.label,
  );
  const reset = formatQuotaReset(primary.resetAt);
  const detail = [primary.displayName, primary.label, reset ? `resets ${reset}` : null]
    .filter(Boolean)
    .join(" 路 ");
  const secondaryDetail = secondary
    ? `${secondary.displayName}${secondary.label ? ` ${secondary.label}` : ""} ${secondary.remaining}% left`
    : null;
  const title = [detail, secondaryDetail].filter(Boolean).join(" 路 ");
  const severity = primary.remaining <= 10 ? "danger" : primary.remaining <= 25 ? "warn" : "ok";

  return html`
    <a
      class="chat-controls__quota chat-controls__quota--${severity}"
      href=${pathForTab("usage", state.basePath)}
      title=${title}
      aria-label=${`Provider usage: ${title}`}
      data-chat-provider-usage="true"
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
        state.setTab("usage");
      }}
    >
      <span class="chat-controls__quota-label">${t("tabs.usage")}</span>
      <span class="chat-controls__quota-value">${primary.remaining}%</span>
    </a>
  `;
}

function renderChatAgentSelect(
  state: AppViewState,
  onSwitchSession: ChatSessionSwitchHandler,
  options = resolveChatAgentFilterOptions(state),
) {
  if (options.length <= 1) {
    return "";
  }
  const activeAgentId = resolveChatAgentFilterId(state, state.sessionKey);
  const selectedLabel = options.find((entry) => entry.id === activeAgentId)?.label ?? activeAgentId;
  return html`
    <label class="field chat-controls__session chat-controls__agent">
      <select
        data-chat-agent-filter="true"
        aria-label=${t("chat.selectors.agentFilter")}
        title=${selectedLabel}
        .value=${activeAgentId}
        ?disabled=${!state.connected}
        @change=${(e: Event) => {
          const nextAgentId = normalizeAgentId((e.target as HTMLSelectElement).value);
          if (nextAgentId === activeAgentId) {
            return;
          }
          onSwitchSession(state, resolvePreferredSessionForAgent(state, nextAgentId));
        }}
      >
        ${repeat(
          options,
          (entry) => entry.id,
          (entry) =>
            html`<option value=${entry.id} ?selected=${entry.id === activeAgentId}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

async function refreshVisibleToolsEffectiveForCurrentSessionLazy(state: AppViewState) {
  return refreshVisibleToolsEffectiveForCurrentSession(state);
}

function renderChatModelSelect(state: AppViewState) {
  const { currentOverride, defaultLabel, options } = resolveChatModelSelectState(state);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  if (busy) (state as any).___modelPopoverOpen = false;
  const disabled =
    !state.connected ||
    busy ||
    Boolean(state.chatModelSwitchPromises?.[state.sessionKey]) ||
    (state.chatModelsLoading && options.length === 0) ||
    !state.client;
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);

  // Group models by family (first word before space)
  const groups = new Map<string, typeof options>();
  const GROUP_ORDER = ['DeepSeek','GPT','Claude','GLM','Gemini','Qwen','Kimi','MiniMax','MiMo','Doubao','Grok','ABAB','Other'];
  for (const opt of options) {
    const sp = opt.label.indexOf(' ');
    let group: string;
    if (sp <= 0) {
      group = 'Other';
    } else {
      const first = opt.label.slice(0, sp);
      group = GROUP_ORDER.includes(first) ? first : first;
    }
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(opt);
  }
  const sortedNames = GROUP_ORDER.filter(g => groups.has(g));
  sortedNames.push(...Array.from(groups.keys()).filter(g => !GROUP_ORDER.includes(g)));

  // Collapse state
  const modelStateKey = '___modelColors' as keyof AppViewState;
  if (!(state as any).___modelCollapsed) (state as any).___modelCollapsed = new Set<string>();
  const collapsed = (state as any).___modelCollapsed as Set<string>;
  const toggleGroup = (name: string) => {
    if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
    (state as any).requestUpdate?.();
  };
  const toggleAllGroups = () => {
    const allCollapsed = sortedNames.every(g => collapsed.has(g));
    for (const g of sortedNames) {
      if (allCollapsed) collapsed.delete(g); else collapsed.add(g);
    }
    (state as any).requestUpdate?.();
  };
  // Popover open state
  if (!(state as any).___modelPopoverOpen) (state as any).___modelPopoverOpen = false;
  const togglePopover = () => {
    (state as any).___modelPopoverOpen = !(state as any).___modelPopoverOpen;
    (state as any).requestUpdate?.();
  };
  const closePopover = () => {
    (state as any).___modelPopoverOpen = false;
    (state as any).requestUpdate?.();
  };

  return html`
    <style>
      .model-sel { position:relative; display:inline-flex; flex:1; min-width:0; }
      .model-sel-trigger {
        display:flex; align-items:center; gap:6px; width:100%; flex:1;
        min-height:36px; padding:8px 10px 8px 12px; box-sizing:border-box;
        border:1px solid var(--input);
        border-radius:var(--radius-md,10px); background:var(--bg-elevated);
        cursor:pointer; font:inherit; font-size:14px; line-height:1.2; text-align:left; white-space:nowrap;
        color:var(--text);
      }
      .model-sel-trigger:disabled { opacity:.5; cursor:default; }
      .model-sel-trigger-label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .model-sel-trigger-arrow { display:inline-flex; width:16px; height:16px; transition:transform .2s; color:var(--muted); }
      .model-sel-trigger-arrow.open { transform:rotate(180deg); }
      .model-sel-trigger-arrow svg { width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.5px; }
      .model-sel-panel {
        position:absolute; top:100%; left:0; right:auto; z-index:100; margin-top:2px;
        min-width:100%; max-height:360px; overflow-y:auto;
        background:var(--color-elevated-bg,var(--color-surface-bg,#fff));
        border:1px solid var(--color-border,rgba(0,0,0,.12));
        border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,.15);
        display:none;
      }
      .model-sel-panel::-webkit-scrollbar { width:4px; }
      .model-sel-panel::-webkit-scrollbar-track { background:transparent; }
      .model-sel-panel::-webkit-scrollbar-thumb { background:rgba(0,0,0,.08); border-radius:2px; }
      .model-sel-panel.open { display:block; }
      .model-sel-group {}
            .model-sel-group-header {
        display:flex; align-items:center; gap:4px; width:100%;
        padding:6px 8px; background:var(--color-group-header,rgba(0,0,0,.04));
        cursor:pointer; border:none; font-size:11px; font-weight:600;
        color:var(--color-text,#333); text-align:left;
      }
      .model-sel-group-header:hover { background:var(--color-group-header-hover,rgba(0,0,0,.08)); }
      .model-sel-group-arrow { display:inline-flex; width:14px; height:14px; transition:transform .2s; color:var(--muted); }
      .model-sel-group-arrow.collapsed { transform:rotate(-90deg); }
      .model-sel-group-arrow svg { width:14px; height:14px; stroke:currentColor; fill:none; stroke-width:1.5px; }
      .model-sel-group-count { margin-left:auto; font-size:10px; color:var(--color-text-dim,#888); }
      .model-sel-group-items { }
      .model-sel-group-items.collapsed { display:none; }
      .model-sel-opt {
        display:block; width:100%; padding:5px 12px 5px 20px;
        border:none; background:transparent; cursor:pointer; font-size:12px;
        color:var(--color-text,#333); text-align:left;
      }
            .model-sel-opt:hover { background:var(--color-opt-hover,rgba(0,0,0,.06)); }
      .model-sel-opt.selected { background:var(--color-opt-selected,rgba(0,100,240,.12)); font-weight:600; }
      .model-sel-opt--default { display:flex; align-items:center; padding:5px 8px 5px 12px; border-bottom:1px solid var(--color-border,rgba(0,0,0,.08)); gap:4px; }
      .model-sel-opt-btn { flex:1; padding:0; border:none; background:transparent; cursor:pointer; font-size:12px; color:var(--color-text,#333); text-align:left; }
      .model-sel-opt-btn:hover { opacity:.8; }
      .model-sel-opt-btn.selected { font-weight:600; }
      .model-sel-opt-toggle { display:inline-flex; align-items:center; justify-content:center; padding:2px; border:none; background:transparent; cursor:pointer; color:var(--color-text-dim,#888); border-radius:4px; }
      .model-sel-opt-toggle:hover { background:var(--color-opt-hover,rgba(0,0,0,.08)); }
      .model-sel-toggle-arrow { display:inline-flex; width:16px; height:16px; transition:transform .2s; color:var(--muted); }
      .model-sel-toggle-arrow.collapsed { transform:rotate(-90deg); }
      .model-sel-toggle-arrow svg { width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.5px; }
    </style>
    <div class="model-sel">
      <button class="model-sel-trigger" type="button" ?disabled=${disabled}
        @click=${() => togglePopover()}
        @blur=${(e: FocusEvent) => { if (!(e.relatedTarget as HTMLElement)?.closest?.('.model-sel-panel')) closePopover(); }}>
        <span class="model-sel-trigger-label">${selectedLabel}</span>
        <span class="model-sel-trigger-arrow ${(state as any).___modelPopoverOpen ? 'open' : ''}">${icons.chevronDown}</span>
      </button>
      <div class="model-sel-panel ${(state as any).___modelPopoverOpen ? 'open' : ''}">
        <div class="model-sel-opt model-sel-opt--default ${currentOverride === '' ? 'selected' : ''}">
          <button class="model-sel-opt-btn" type="button"
            ?disabled=${disabled}
            @mousedown=${() => { closePopover(); switchChatModel(state, '').catch(()=>{}); }}>
            ${defaultLabel}
          </button>
          <button class="model-sel-opt-toggle" type="button" @click=${toggleAllGroups}>
            <span class="model-sel-toggle-arrow ${sortedNames.every(g => collapsed.has(g)) ? 'collapsed' : ''}">${icons.chevronDown}</span>
          </button>
        </div>
        ${sortedNames.map(name => {
          const items = groups.get(name)!;
          const isCollapsed = collapsed.has(name);
          return html`
            <div class="model-sel-group">
              <button class="model-sel-group-header" type="button" @click=${() => toggleGroup(name)}>
                <span class="model-sel-group-arrow ${isCollapsed ? 'collapsed' : ''}">${icons.chevronDown}</span>
                <span>${name}</span>
                <span class="model-sel-group-count">${items.length}</span>
              </button>
              <div class="model-sel-group-items ${isCollapsed ? 'collapsed' : ''}">
                ${items.map(entry => html`
                  <button class="model-sel-opt ${entry.value === currentOverride ? 'selected' : ''}" type="button"
                    ?disabled=${disabled}
                    @mousedown=${() => { closePopover(); switchChatModel(state, entry.value).catch(()=>{}); }}>
                    ${entry.label}
                  </button>
                `)}
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
};

type ChatThinkingSelectOption = {
  value: string;
  label: string;
};

type ChatThinkingSelectState = {
  currentOverride: string;
  defaultLabel: string;
  options: ChatThinkingSelectOption[];
};

function resolveThinkingTargetModel(state: AppViewState): {
  provider: string | null;
  model: string | null;
} {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  return {
    provider: activeRow?.modelProvider ?? state.sessionsResult?.defaults?.modelProvider ?? null,
    model: activeRow?.model ?? state.sessionsResult?.defaults?.model ?? null,
  };
}

function buildThinkingOptions(
  levels: readonly GatewayThinkingLevelOption[],
  currentOverride: string,
): ChatThinkingSelectOption[] {
  const seen = new Set<string>();
  const options: ChatThinkingSelectOption[] = [];

  const addOption = (value: string, label?: string) => {
    const normalizedValue = normalizeThinkingOptionValue(value);
    pushUniqueTrimmedSelectOption(options, seen, normalizedValue, () =>
      formatThinkingOverrideLabel(normalizedValue, label),
    );
  };

  for (const level of levels) {
    addOption(level.id, level.label);
  }
  if (currentOverride) {
    addOption(currentOverride);
  }
  return options;
}

function isOffThinkingOption(value: string | null | undefined): boolean {
  return normalizeThinkingOptionValue(value ?? "") === "off";
}

function isOffOnlyThinkingLevels(levels: readonly GatewayThinkingLevelOption[]): boolean {
  return levels.every((level) => isOffThinkingOption(level.id || level.label));
}

function resolveThinkingLevelOptions(
  activeRow: SessionsListResult["sessions"][number] | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  provider: string | null,
  model: string | null,
  catalog: readonly ThinkingCatalogEntry[],
): GatewayThinkingLevelOption[] {
  const sessionModelMatchesDefaults =
    (!activeRow?.modelProvider || activeRow.modelProvider === defaults?.modelProvider) &&
    (!activeRow?.model || activeRow.model === defaults?.model);
  const catalogEntry =
    provider && model
      ? catalog.find((entry) => entry.provider === provider && entry.id === model)
      : undefined;
  const explicitLevels =
    (activeRow?.thinkingLevels?.length ? activeRow.thinkingLevels : null) ??
    (sessionModelMatchesDefaults && defaults?.thinkingLevels?.length
      ? defaults.thinkingLevels
      : null);
  if (explicitLevels) {
    if (catalogEntry?.reasoning === false && isOffOnlyThinkingLevels(explicitLevels)) {
      return [];
    }
    return explicitLevels;
  }
  const explicitLabels =
    (activeRow?.thinkingOptions?.length ? activeRow.thinkingOptions : null) ??
    (sessionModelMatchesDefaults && defaults?.thinkingOptions?.length
      ? defaults.thinkingOptions
      : null);
  if (catalogEntry?.reasoning === false) {
    if (!explicitLabels || explicitLabels.every(isOffThinkingOption)) {
      return [];
    }
  }
  const labels =
    explicitLabels ??
    (provider && model ? listThinkingLevelLabels(provider, model) : listThinkingLevelLabels());
  return labels.map((label) => ({
    id: normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label),
    label,
  }));
}

export function resolveChatThinkingSelectState(state: AppViewState): ChatThinkingSelectState {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const persisted = activeRow?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const { provider, model } = resolveThinkingTargetModel(state);
  const levels = resolveThinkingLevelOptions(
    activeRow,
    state.sessionsResult?.defaults,
    provider,
    model,
    state.chatModelCatalog ?? [],
  );
  const defaultLevel =
    activeRow?.thinkingDefault ??
    state.sessionsResult?.defaults?.thinkingDefault ??
    (provider && model
      ? resolveThinkingDefaultForModel({
          provider,
          model,
          catalog: state.chatModelCatalog ?? [],
        })
      : "off");
  const effectiveOverride = levels.length === 0 && currentOverride === "off" ? "" : currentOverride;
  return {
    currentOverride: effectiveOverride,
    defaultLabel: formatInheritedThinkingLabel(defaultLevel),
    options: buildThinkingOptions(levels, effectiveOverride),
  };
}

export function renderChatThinkingSelect(state: AppViewState) {
  const { currentOverride, defaultLabel, options } = resolveChatThinkingSelectState(state);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled =
    !state.connected || busy || !state.client || (options.length === 0 && currentOverride === "");
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  const onChange = async (e: Event) => {
    const next = (e.target as HTMLSelectElement).value.trim();
    await switchChatThinkingLevel(state, next);
  };
  return html`
    <label class="field chat-controls__session chat-controls__thinking-select">
      <select
        class="chat-controls__thinking-select-full"
        data-chat-thinking-select="true"
        aria-label=${t("chat.selectors.thinkingLevel")}
        title=${selectedLabel}
        ?disabled=${disabled}
        @change=${onChange}
      >
        <option value="" ?selected=${currentOverride === ""}>${defaultLabel}</option>
        ${repeat(
          options,
          (entry) => entry.value,
          (entry) =>
            html`<option value=${entry.value} ?selected=${entry.value === currentOverride}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

async function switchChatModel(state: AppViewState, nextModel: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const currentOverride = resolveChatModelOverrideValue(state);
  if (currentOverride === nextModel) {
    return true;
  }
  const targetSessionKey = state.sessionKey;
  const prevOverride = state.chatModelOverrides[targetSessionKey];
  state.lastError = null;
  // Write the override cache immediately so the picker stays in sync during the RPC round-trip.
  state.chatModelOverrides = {
    ...state.chatModelOverrides,
    [targetSessionKey]: createChatModelOverride(nextModel),
  };
  const client = state.client;
  let switchPromise: Promise<boolean>;
  const clearPendingSwitch = () => {
    if (state.chatModelSwitchPromises?.[targetSessionKey] === switchPromise) {
      const nextSwitches = { ...state.chatModelSwitchPromises };
      delete nextSwitches[targetSessionKey];
      state.chatModelSwitchPromises = nextSwitches;
    }
  };
  switchPromise = (async () => {
    try {
      await client.request("sessions.patch", {
        key: targetSessionKey,
        model: nextModel || null,
      });
      void refreshVisibleToolsEffectiveForCurrentSessionLazy(state);
      await refreshSessionOptions(state);
      return true;
    } catch (err) {
      // Roll back so the picker reflects the actual server model.
      state.chatModelOverrides = { ...state.chatModelOverrides, [targetSessionKey]: prevOverride };
      state.lastError = `Failed to set model: ${String(err)}`;
      return false;
    } finally {
      clearPendingSwitch();
    }
  })();
  state.chatModelSwitchPromises = {
    ...state.chatModelSwitchPromises,
    [targetSessionKey]: switchPromise,
  };
  return switchPromise;
}

function patchSessionThinkingLevel(
  state: AppViewState,
  sessionKey: string,
  thinkingLevel: string | undefined,
) {
  const current = state.sessionsResult;
  if (!current) {
    return;
  }
  state.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      row.key === sessionKey ? Object.assign({}, row, { thinkingLevel }) : row,
    ),
  };
}

async function switchChatThinkingLevel(state: AppViewState, nextThinkingLevel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousThinkingLevel = activeRow?.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(nextThinkingLevel) ?? nextThinkingLevel.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return;
  }
  state.lastError = null;
  patchSessionThinkingLevel(state, targetSessionKey, normalizedNext);
  state.chatThinkingLevel = normalizedNext ?? null;
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      thinkingLevel: normalizedNext ?? null,
    });
    await refreshSessionOptions(state);
  } catch (err) {
    patchSessionThinkingLevel(state, targetSessionKey, previousThinkingLevel);
    state.chatThinkingLevel = normalizedPrev ?? null;
    state.lastError = `Failed to set thinking level: ${String(err)}`;
  }
}

type SessionOptionEntry = {
  key: string;
  label: string;
  scopeLabel: string;
  title: string;
};

export type SessionOptionGroup = {
  id: string;
  label: string;
  options: SessionOptionEntry[];
};

type ChatAgentFilterOption = {
  id: string;
  label: string;
};

function resolveChatAgentFilterId(state: AppViewState, sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? state.agentsList?.defaultId ?? "main");
}

function isSessionKeyTiedToAgent(key: string, agentId: string, defaultAgentId: string): boolean {
  const parsed = parseAgentSessionKey(key);
  if (parsed) {
    return normalizeAgentId(parsed.agentId) === agentId;
  }
  return agentId === defaultAgentId;
}

function resolvePreferredSessionForAgent(state: AppViewState, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (resolveChatAgentFilterId(state, state.sessionKey) === normalizedAgentId) {
    return state.sessionKey;
  }
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const eligible = (state.sessionsResult?.sessions ?? [])
    .filter((row) => {
      if (!isSessionKeyTiedToAgent(row.key, normalizedAgentId, defaultAgentId)) {
        return false;
      }
      if (row.kind === "global" || row.kind === "unknown") {
        return false;
      }
      if (isCronSessionKey(row.key)) {
        return false;
      }
      return !isSubagentSessionKey(row.key) && !row.spawnedBy;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (eligible[0]?.key) {
    return eligible[0].key;
  }
  return buildAgentMainSessionKey({ agentId: normalizedAgentId });
}

function resolveChatAgentFilterOptions(state: AppViewState): ChatAgentFilterOption[] {
  const seen = new Set<string>();
  const options: ChatAgentFilterOption[] = [];
  const add = (agentId: string) => {
    const normalized = normalizeAgentId(agentId);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    options.push({
      id: normalized,
      label: resolveAgentGroupLabel(state, normalized),
    });
  };

  add(resolveChatAgentFilterId(state, state.sessionKey));
  add(state.agentsList?.defaultId ?? "main");
  for (const agent of state.agentsList?.agents ?? []) {
    add(agent.id);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    const parsed = parseAgentSessionKey(row.key);
    if (parsed) {
      add(parsed.agentId);
    }
  }

  return options;
}

export function resolveSessionOptionGroups(
  state: AppViewState,
  sessionKey: string,
  sessions: SessionsListResult | null,
): SessionOptionGroup[] {
  const rows = sessions?.sessions ?? [];
  const hideCron = state.sessionsHideCron ?? true;
  const activeAgentId = resolveChatAgentFilterId(state, sessionKey);
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of rows) {
    byKey.set(row.key, row);
  }

  const seenKeys = new Set<string>();
  const groups = new Map<string, SessionOptionGroup>();
  const ensureGroup = (groupId: string, label: string): SessionOptionGroup => {
    const existing = groups.get(groupId);
    if (existing) {
      return existing;
    }
    const created: SessionOptionGroup = {
      id: groupId,
      label,
      options: [],
    };
    groups.set(groupId, created);
    return created;
  };

  const addOption = (key: string) => {
    if (!key || seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    const row = byKey.get(key);
    const parsed = parseAgentSessionKey(key);
    const group = parsed
      ? ensureGroup(
          `agent:${normalizeLowercaseStringOrEmpty(parsed.agentId)}`,
          resolveAgentGroupLabel(state, parsed.agentId),
        )
      : ensureGroup("other", "Other Sessions");
    const scopeLabel = normalizeOptionalString(parsed?.rest) ?? key;
    group.options.push({
      key,
      label: resolveSessionScopedOptionLabel(key, row, parsed?.rest),
      scopeLabel,
      title: key,
    });
  };

  for (const row of rows) {
    if (
      !isSessionKeyTiedToAgent(row.key, activeAgentId, defaultAgentId) &&
      row.key !== sessionKey
    ) {
      continue;
    }
    if (row.key !== sessionKey && (row.kind === "global" || row.kind === "unknown")) {
      continue;
    }
    if (hideCron && row.key !== sessionKey && isCronSessionKey(row.key)) {
      continue;
    }
    const isSubagent = isSubagentSessionKey(row.key) || !!row.spawnedBy;
    if (isSubagent && row.key !== sessionKey) {
      continue;
    }
    addOption(row.key);
  }
  if (byKey.has(sessionKey)) {
    addOption(sessionKey);
  } else if (sessionKey) {
    addOption(sessionKey);
  }

  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const option of group.options) {
      counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    }
    for (const option of group.options) {
      if ((counts.get(option.label) ?? 0) > 1 && option.scopeLabel !== option.label) {
        option.label = `${option.label} 路 ${option.scopeLabel}`;
      }
    }
  }

  const allOptions = Array.from(groups.values()).flatMap((group) =>
    group.options.map((option) => ({ groupLabel: group.label, option })),
  );
  const labels = new Map(allOptions.map(({ option }) => [option, option.label]));
  const countAssignedLabels = () => {
    const counts = new Map<string, number>();
    for (const { option } of allOptions) {
      const label = labels.get(option) ?? option.label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  };
  const labelIncludesScopeLabel = (label: string, scopeLabel: string) => {
    const trimmedScope = scopeLabel.trim();
    if (!trimmedScope) {
      return false;
    }
    return (
      label === trimmedScope ||
      label.endsWith(` 路 ${trimmedScope}`) ||
      label.endsWith(` / ${trimmedScope}`)
    );
  };

  const globalCounts = countAssignedLabels();
  for (const { groupLabel, option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((globalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    const scopedPrefix = `${groupLabel} / `;
    if (currentLabel.startsWith(scopedPrefix)) {
      continue;
    }
    // Keep the agent visible once the native select collapses to a single chosen label.
    labels.set(option, `${groupLabel} / ${currentLabel}`);
  }

  const scopedCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((scopedCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    if (labelIncludesScopeLabel(currentLabel, option.scopeLabel)) {
      continue;
    }
    labels.set(option, `${currentLabel} 路 ${option.scopeLabel}`);
  }

  const finalCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((finalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    // Fall back to the full key only when every friendlier disambiguator still collides.
    labels.set(option, `${currentLabel} 路 ${option.key}`);
  }

  for (const { option } of allOptions) {
    option.label = labels.get(option) ?? option.label;
  }

  return Array.from(groups.values());
}

function resolveAgentGroupLabel(state: AppViewState, agentIdRaw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(agentIdRaw);
  const agent = (state.agentsList?.agents ?? []).find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === normalized,
  );
  const name =
    normalizeOptionalString(agent?.identity?.name) ?? normalizeOptionalString(agent?.name) ?? "";
  return name && name !== agentIdRaw ? `${name} (${agentIdRaw})` : agentIdRaw;
}

function resolveSessionScopedOptionLabel(
  key: string,
  row?: SessionsListResult["sessions"][number],
  rest?: string,
) {
  const base = normalizeOptionalString(rest) ?? key;
  if (!row) {
    return base;
  }

  const label = normalizeOptionalString(row.label) ?? "";
  const displayName = normalizeOptionalString(row.displayName) ?? "";
  if ((label && label !== key) || (displayName && displayName !== key)) {
    return resolveSessionDisplayName(key, row);
  }

  return base;
}






