// Skill Workshop feature owns its Control UI render glue and page preferences.
import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { RouteModule } from "../../routes/route-types.ts";
import { createChatSessionsLoadOverrides } from "../../ui/app-chat.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { switchChatSessionAndWait } from "../../ui/chat-session-switch.ts";
import { loadChatHistory } from "../../ui/controllers/chat.ts";
import { createSessionAndRefresh, loadSessions } from "../../ui/controllers/sessions.ts";
import {
  countSkillWorkshopProposals,
  loadSkillWorkshopProposals,
  requestSkillWorkshopRevision,
  runSkillWorkshopLifecycleAction,
  selectSkillWorkshopProposal,
} from "../../ui/controllers/skill-workshop.ts";
import { createLazyView, renderLazyView } from "../../ui/lazy-view.ts";
import { normalizeAgentId } from "../../ui/session-key.ts";
import { normalizeOptionalString } from "../../ui/string-coerce.ts";
import type { GatewaySessionRow } from "../../ui/types.ts";

const SKILL_WORKSHOP_MODE_KEY = "openclaw:control-ui:skill-workshop-mode:v1";
const SKILL_WORKSHOP_CURRENT_CHAT_REVISIONS_KEY =
  "openclaw:control-ui:skill-workshop-current-chat-revisions:v1";

export function loadSkillWorkshopMode(): "board" | "today" {
  try {
    const raw = getSafeLocalStorage()?.getItem(SKILL_WORKSHOP_MODE_KEY);
    return raw === "board" ? "board" : "today";
  } catch {
    return "today";
  }
}

export function loadSkillWorkshopUseCurrentChatForRevisions(): boolean {
  try {
    return getSafeLocalStorage()?.getItem(SKILL_WORKSHOP_CURRENT_CHAT_REVISIONS_KEY) === "true";
  } catch {
    return false;
  }
}

function setSkillWorkshopUseCurrentChatForRevisions(state: AppViewState, enabled: boolean): void {
  state.skillWorkshopUseCurrentChatForRevisions = enabled;
  try {
    getSafeLocalStorage()?.setItem(SKILL_WORKSHOP_CURRENT_CHAT_REVISIONS_KEY, String(enabled));
  } catch {
    // Preference persistence is optional; the active toggle still controls this handoff.
  }
}

function setSkillWorkshopMode(state: AppViewState, mode: "board" | "today"): void {
  if (state.skillWorkshopMode === mode) {
    return;
  }
  state.skillWorkshopMode = mode;
  try {
    getSafeLocalStorage()?.setItem(SKILL_WORKSHOP_MODE_KEY, mode);
  } catch {
    // Mode persistence is a convenience; the in-memory switch still works.
  }
}

function findSkillWorkshopRevisionSessionRow(
  state: AppViewState,
  sessionKey: string | undefined,
): GatewaySessionRow | null {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return null;
  }
  const current = state.sessionsResult?.sessions.find((row) => row.key === key);
  if (current) {
    return current;
  }
  for (const rows of Object.values(state.chatAgentSessionRowsByAgent ?? {})) {
    const cached = rows.find((row) => row.key === key);
    if (cached) {
      return cached;
    }
  }
  return null;
}

function isUsableSkillWorkshopRevisionSession(
  row: GatewaySessionRow | null,
): row is GatewaySessionRow {
  return Boolean(row && !row.archived && !row.hasActiveRun);
}

async function ensureSkillWorkshopRevisionSessionsLoaded(
  state: AppViewState,
  agentId: string,
): Promise<void> {
  const resultAgentId = normalizeOptionalString(state.sessionsResultAgentId);
  if (resultAgentId === agentId && state.sessionsResult?.sessions.length) {
    return;
  }
  await loadSessions(state, {
    ...createChatSessionsLoadOverrides(state),
    agentId,
  });
}

async function resolveSkillWorkshopRevisionSessionKey(
  state: AppViewState,
  proposal: { key: string; slug: string; origin?: { agentId?: string; sessionKey?: string } },
  proposalAgentId: string,
): Promise<string | null> {
  if (state.skillWorkshopUseCurrentChatForRevisions) {
    return normalizeOptionalString(state.sessionKey) ?? null;
  }

  const agentId = normalizeAgentId(proposal.origin?.agentId ?? proposalAgentId);
  await ensureSkillWorkshopRevisionSessionsLoaded(state, agentId);

  const originRow = findSkillWorkshopRevisionSessionRow(state, proposal.origin?.sessionKey);
  if (isUsableSkillWorkshopRevisionSession(originRow)) {
    return originRow.key;
  }

  return createSessionAndRefresh(
    state as unknown as Parameters<typeof createSessionAndRefresh>[0],
    {
      agentId,
      label: `Skill Workshop: ${proposal.slug || proposal.key}`.slice(0, 80),
    },
    {
      ...createChatSessionsLoadOverrides(state),
      agentId,
    },
  );
}

async function sendSkillWorkshopRevisionRequest(
  state: AppViewState,
  instructions: string,
  proposal: { key: string; slug: string; origin?: { agentId?: string; sessionKey?: string } },
  proposalAgentId: string,
): Promise<void> {
  if (!state.client || !state.connected) {
    throw new Error("Gateway is not connected.");
  }
  const sessionKey = await resolveSkillWorkshopRevisionSessionKey(state, proposal, proposalAgentId);
  if (!sessionKey) {
    throw new Error(state.sessionsError ?? "Could not prepare a Skill Workshop session.");
  }
  if (state.routeId !== "chat") {
    state.setRoute("chat");
  }
  if (state.sessionKey === sessionKey) {
    await loadChatHistory(state);
  } else {
    await switchChatSessionAndWait(state, sessionKey);
  }
  const scopedProposalAgentId = proposal.origin?.agentId?.trim() || proposalAgentId;
  await state.handleSendChat(instructions, {
    restoreDraft: true,
    skillWorkshopRevision: {
      proposalId: proposal.key,
      agentId: scopedProposalAgentId,
    },
  });
}

function renderSkillWorkshopHeaderControls(state: AppViewState) {
  const useCurrentChatLabel = t("skillWorkshop.header.useCurrentChat");
  return html`
    <div class="sw-header-controls">
      <label
        class="sw-revision-session-toggle"
        title=${t("skillWorkshop.header.useCurrentChatTooltip")}
      >
        <input
          type="checkbox"
          aria-label=${t("skillWorkshop.header.useCurrentChatAria")}
          .checked=${state.skillWorkshopUseCurrentChatForRevisions}
          @change=${(event: Event) =>
            setSkillWorkshopUseCurrentChatForRevisions(
              state,
              (event.currentTarget as HTMLInputElement).checked,
            )}
        />
        <span class="sw-revision-session-toggle__track" aria-hidden="true"></span>
        <span class="sw-revision-session-toggle__label">${useCurrentChatLabel}</span>
      </label>
      <div
        class="sw-mode-switch"
        role="tablist"
        aria-label="Workshop view"
        data-mode=${state.skillWorkshopMode}
      >
        <button
          type="button"
          class="sw-mode-switch__opt ${state.skillWorkshopMode === "board" ? "is-active" : ""}"
          role="tab"
          aria-selected=${state.skillWorkshopMode === "board" ? "true" : "false"}
          title="Board view"
          @click=${() => setSkillWorkshopMode(state, "board")}
        >
          <svg viewBox="0 0 24 24" class="sw-mode-switch__icon" aria-hidden="true">
            <rect x="3" y="4" width="7" height="16" rx="1.5" />
            <rect x="14" y="4" width="7" height="9" rx="1.5" />
            <rect x="14" y="15" width="7" height="5" rx="1.5" />
          </svg>
          <span>Board</span>
        </button>
        <button
          type="button"
          class="sw-mode-switch__opt ${state.skillWorkshopMode === "today" ? "is-active" : ""}"
          role="tab"
          aria-selected=${state.skillWorkshopMode === "today" ? "true" : "false"}
          title="Today view"
          @click=${() => setSkillWorkshopMode(state, "today")}
        >
          <svg viewBox="0 0 24 24" class="sw-mode-switch__icon" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"
            />
          </svg>
          <span>Today</span>
        </button>
        <span class="sw-mode-switch__indicator" aria-hidden="true"></span>
      </div>
    </div>
  `;
}

export function createSkillWorkshopFeature(notifyLazyViewChanged: () => void) {
  const lazySkillWorkshop = createLazyView(
    () => import("../../ui/views/skill-workshop.ts"),
    notifyLazyViewChanged,
  );

  return {
    routeId: "skill-workshop" as const,
    contentClass(state: AppViewState) {
      return state.skillWorkshopMode === "today"
        ? "content--skill-workshop content--skill-workshop-today"
        : "content--skill-workshop";
    },
    renderHeaderControls: renderSkillWorkshopHeaderControls,
    renderView(state: AppViewState) {
      return renderLazyView(lazySkillWorkshop, (m) => {
        const visibleProposals = m.filterSkillWorkshopProposals(
          state.skillWorkshopProposals,
          state.skillWorkshopStatusFilter,
          state.skillWorkshopQuery,
        );
        const selectedIndex = visibleProposals.findIndex(
          (proposal) => proposal.key === state.skillWorkshopSelectedKey,
        );
        const selectRelativeProposal = (delta: -1 | 1) => {
          if (visibleProposals.length === 0) {
            return;
          }
          const nextIndex =
            selectedIndex < 0
              ? 0
              : (selectedIndex + delta + visibleProposals.length) % visibleProposals.length;
          selectSkillWorkshopProposal(state, visibleProposals[nextIndex].key);
        };
        const selectVisibleFallback = (proposals: typeof visibleProposals) => {
          if (
            proposals.length === 0 ||
            proposals.some((proposal) => proposal.key === state.skillWorkshopSelectedKey)
          ) {
            return;
          }
          state.skillWorkshopFilePreviewKey = null;
          selectSkillWorkshopProposal(state, proposals[0].key);
        };
        return m.renderSkillWorkshop({
          loading: state.skillWorkshopLoading,
          error: state.skillWorkshopError,
          inspectingKey: state.skillWorkshopInspectingKey,
          proposals: state.skillWorkshopProposals,
          selectedKey: state.skillWorkshopSelectedKey,
          statusFilter: state.skillWorkshopStatusFilter,
          query: state.skillWorkshopQuery,
          filePreviewKey: state.skillWorkshopFilePreviewKey,
          filePreviewQuery: state.skillWorkshopFilePreviewQuery,
          queueWidth: state.skillWorkshopQueueWidth,
          mode: state.skillWorkshopMode,
          actionBusy: state.skillWorkshopActionBusy,
          actionNotice: state.skillWorkshopActionNotice,
          revisionKey: state.skillWorkshopRevisionKey,
          revisionDraft: state.skillWorkshopRevisionDraft,
          assistantName: state.assistantName,
          counts: countSkillWorkshopProposals(state.skillWorkshopProposals),
          onStatusFilterChange: (status) => {
            state.skillWorkshopStatusFilter = status;
            selectVisibleFallback(
              m.filterSkillWorkshopProposals(
                state.skillWorkshopProposals,
                status,
                state.skillWorkshopQuery,
              ),
            );
          },
          onQueryChange: (query) => {
            state.skillWorkshopQuery = query;
            selectVisibleFallback(
              m.filterSkillWorkshopProposals(
                state.skillWorkshopProposals,
                state.skillWorkshopStatusFilter,
                query,
              ),
            );
          },
          onFilePreviewQueryChange: (query) => (state.skillWorkshopFilePreviewQuery = query),
          onQueueWidthChange: (width) => (state.skillWorkshopQueueWidth = width),
          onModeChange: (mode) => setSkillWorkshopMode(state, mode),
          onSelect: (key) => {
            state.skillWorkshopFilePreviewKey = null;
            selectSkillWorkshopProposal(state, key);
          },
          onPrev: () => selectRelativeProposal(-1),
          onNext: () => selectRelativeProposal(1),
          onApply: (key) => void runSkillWorkshopLifecycleAction(state, "apply", key),
          onRevise: (key) => {
            state.skillWorkshopRevisionKey = key;
            state.skillWorkshopRevisionDraft = "";
          },
          onReject: (key) => void runSkillWorkshopLifecycleAction(state, "reject", key),
          onRevisionDraftChange: (draft) => (state.skillWorkshopRevisionDraft = draft),
          onRevisionCancel: () => {
            state.skillWorkshopRevisionKey = null;
            state.skillWorkshopRevisionDraft = "";
          },
          onRevisionSubmit: (key) =>
            void requestSkillWorkshopRevision(state, key, (message, proposal, agentId) =>
              sendSkillWorkshopRevisionRequest(state, message, proposal, agentId),
            ),
          onPreviewFile: (key, path) => {
            state.skillWorkshopSelectedKey = key;
            state.skillWorkshopFilePreviewKey = path;
          },
          onClosePreview: () => {
            state.skillWorkshopFilePreviewKey = null;
            state.skillWorkshopFilePreviewQuery = "";
          },
        });
      });
    },
  };
}

export function createSkillWorkshopRoute(
  notifyLazyViewChanged: () => void = () => undefined,
): RouteModule<"skill-workshop"> {
  const feature = createSkillWorkshopFeature(notifyLazyViewChanged);
  return {
    id: "skill-workshop",
    refresh: ({ app }) => loadSkillWorkshopProposals(app, { force: true }),
    contentClass: feature.contentClass,
    renderHeaderControls: feature.renderHeaderControls,
    renderView: feature.renderView,
  } as const;
}
