// Skill Workshop page owns its Control UI render glue.
import { html } from "lit";
import type { RouteRenderContext } from "../../app-routes.ts";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { normalizeAgentId } from "../../ui/session-key.ts";
import { normalizeOptionalString } from "../../ui/string-coerce.ts";
import type { GatewaySessionRow } from "../../ui/types.ts";
import { createChatSessionsLoadOverrides } from "../chat/data.ts";
import { loadChatHistory } from "../chat/gateway.ts";
import { switchChatSessionAndWait } from "../chat/session-switch.ts";
import { createSessionAndRefresh, loadSessions } from "../sessions/data.ts";
import {
  countSkillWorkshopProposals,
  requestSkillWorkshopRevision,
  runSkillWorkshopLifecycleAction,
  selectSkillWorkshopProposal,
} from "./data.ts";
import { renderSkillWorkshop } from "./view.ts";
import { filterSkillWorkshopProposals } from "./view.ts";

function setSkillWorkshopUseCurrentChatForRevisions(state: AppViewState, enabled: boolean): void {
  state.setSkillWorkshopUseCurrentChatForRevisions(enabled);
}

function setSkillWorkshopMode(state: AppViewState, mode: AppViewState["skillWorkshopMode"]): void {
  state.setSkillWorkshopMode(mode);
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
  navigate: RouteRenderContext["navigate"],
): Promise<void> {
  if (!state.client || !state.connected) {
    throw new Error("Gateway is not connected.");
  }
  const sessionKey = await resolveSkillWorkshopRevisionSessionKey(state, proposal, proposalAgentId);
  if (!sessionKey) {
    throw new Error(state.sessionsError ?? "Could not prepare a Skill Workshop session.");
  }
  navigate("chat");
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

export function renderSkillWorkshopPage(
  state: AppViewState,
  navigate: RouteRenderContext["navigate"],
) {
  const pageClass =
    state.skillWorkshopMode === "today"
      ? "content--skill-workshop content--skill-workshop-today"
      : "content--skill-workshop";

  return html`
    <section class=${pageClass}>
      <section class="content-header">
        <div>
          <div class="page-title">${t("tabs.skillWorkshop")}</div>
          <div class="page-sub">${t("subtitles.skillWorkshop")}</div>
        </div>
        <div class="page-meta">${renderSkillWorkshopHeaderControls(state)}</div>
      </section>
      ${(() => {
        const visibleProposals = filterSkillWorkshopProposals(
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
        return renderSkillWorkshop({
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
              filterSkillWorkshopProposals(
                state.skillWorkshopProposals,
                status,
                state.skillWorkshopQuery,
              ),
            );
          },
          onQueryChange: (query) => {
            state.skillWorkshopQuery = query;
            selectVisibleFallback(
              filterSkillWorkshopProposals(
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
              sendSkillWorkshopRevisionRequest(state, message, proposal, agentId, navigate),
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
      })()}
    </section>
  `;
}
