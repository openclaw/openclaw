// Skill Workshop page owns its Control UI render glue.
import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext } from "../../app/context.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import {
  countSkillWorkshopProposals,
  createSkillWorkshopState,
  loadSkillWorkshopProposals,
  requestSkillWorkshopRevision,
  runSkillWorkshopLifecycleAction,
  selectSkillWorkshopProposal,
  type SkillWorkshopContext,
  type SkillWorkshopRouteData,
  type SkillWorkshopState,
} from "./proposals.ts";
import {
  loadSkillWorkshopMode,
  loadSkillWorkshopUseCurrentChatForRevisions,
  saveSkillWorkshopMode,
  saveSkillWorkshopUseCurrentChatForRevisions,
} from "./storage.ts";
import { renderSkillWorkshop } from "./view.ts";
import { filterSkillWorkshopProposals } from "./view.ts";

export type SkillWorkshopPageContext = SkillWorkshopContext & {
  assistantName: string;
};

export type SkillWorkshopRevisionRequest = (
  instructions: string,
  proposal: SkillWorkshopState["skillWorkshopProposals"][number],
  proposalAgentId: string,
) => Promise<void>;

type SkillWorkshopRenderContext = {
  context: SkillWorkshopPageContext;
  onRevisionRequest?: SkillWorkshopRevisionRequest;
};

function setSkillWorkshopUseCurrentChatForRevisions(
  state: SkillWorkshopState,
  enabled: boolean,
  requestUpdate: () => void,
): void {
  if (state.skillWorkshopUseCurrentChatForRevisions === enabled) {
    return;
  }
  state.skillWorkshopUseCurrentChatForRevisions = enabled;
  saveSkillWorkshopUseCurrentChatForRevisions(enabled);
  requestUpdate();
}

function setSkillWorkshopMode(
  state: SkillWorkshopState,
  mode: SkillWorkshopState["skillWorkshopMode"],
  requestUpdate: () => void,
) {
  if (state.skillWorkshopMode === mode) {
    return;
  }
  state.skillWorkshopMode = mode;
  saveSkillWorkshopMode(mode);
  requestUpdate();
}

function renderSkillWorkshopHeaderControls(state: SkillWorkshopState) {
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
              requestUpdate,
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
          @click=${() => setSkillWorkshopMode(state, "board", requestUpdate)}
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
          @click=${() => setSkillWorkshopMode(state, "today", requestUpdate)}
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
  state: SkillWorkshopState,
  { context, onRevisionRequest }: SkillWorkshopRenderContext,
  requestUpdate: () => void,
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
          selectSkillWorkshopProposal(state, context, visibleProposals[nextIndex].key);
          requestUpdate();
        };
        const selectVisibleFallback = (proposals: typeof visibleProposals) => {
          if (
            proposals.length === 0 ||
            proposals.some((proposal) => proposal.key === state.skillWorkshopSelectedKey)
          ) {
            return;
          }
          state.skillWorkshopFilePreviewKey = null;
          selectSkillWorkshopProposal(state, context, proposals[0].key);
          requestUpdate();
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
          assistantName: context.assistantName,
          counts: countSkillWorkshopProposals(state.skillWorkshopProposals),
          onStatusFilterChange: (status) => {
            state.skillWorkshopStatusFilter = status;
            requestUpdate();
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
            requestUpdate();
            selectVisibleFallback(
              filterSkillWorkshopProposals(
                state.skillWorkshopProposals,
                state.skillWorkshopStatusFilter,
                query,
              ),
            );
          },
          onFilePreviewQueryChange: (query) => {
            state.skillWorkshopFilePreviewQuery = query;
            requestUpdate();
          },
          onQueueWidthChange: (width) => {
            state.skillWorkshopQueueWidth = width;
            requestUpdate();
          },
          onModeChange: (mode) => setSkillWorkshopMode(state, mode, requestUpdate),
          onSelect: (key) => {
            state.skillWorkshopFilePreviewKey = null;
            selectSkillWorkshopProposal(state, context, key);
            requestUpdate();
          },
          onPrev: () => selectRelativeProposal(-1),
          onNext: () => selectRelativeProposal(1),
          onApply: (key) => {
            void runSkillWorkshopLifecycleAction(state, context, "apply", key).finally(
              requestUpdate,
            );
            requestUpdate();
          },
          onRevise: (key) => {
            state.skillWorkshopRevisionKey = key;
            state.skillWorkshopRevisionDraft = "";
            requestUpdate();
          },
          onReject: (key) => {
            void runSkillWorkshopLifecycleAction(state, context, "reject", key).finally(
              requestUpdate,
            );
            requestUpdate();
          },
          onRevisionDraftChange: (draft) => {
            state.skillWorkshopRevisionDraft = draft;
            requestUpdate();
          },
          onRevisionCancel: () => {
            state.skillWorkshopRevisionKey = null;
            state.skillWorkshopRevisionDraft = "";
            requestUpdate();
          },
          onRevisionSubmit: (key) =>
            onRevisionRequest
              ? void requestSkillWorkshopRevision(state, context, key, onRevisionRequest).finally(
                  requestUpdate,
                )
              : undefined,
          onPreviewFile: (key, path) => {
            state.skillWorkshopSelectedKey = key;
            state.skillWorkshopFilePreviewKey = path;
            requestUpdate();
          },
          onClosePreview: () => {
            state.skillWorkshopFilePreviewKey = null;
            state.skillWorkshopFilePreviewQuery = "";
            requestUpdate();
          },
        });
      })()}
    </section>
  `;
}

export class SkillWorkshopPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context?: SkillWorkshopPageContext;
  @property({ attribute: false }) data?: SkillWorkshopRouteData;
  @property({ attribute: false }) onRevisionRequest?: SkillWorkshopRevisionRequest;

  private state?: SkillWorkshopState;
  private stopGatewaySubscription?: () => void;

  override willUpdate() {
    if (!this.state && this.context) {
      this.state = createSkillWorkshopState(this.data);
      this.state.skillWorkshopMode = loadSkillWorkshopMode();
      this.state.skillWorkshopUseCurrentChatForRevisions =
        loadSkillWorkshopUseCurrentChatForRevisions();
    }
  }

  override firstUpdated() {
    const context = this.context;
    if (!this.state || !context) {
      return;
    }
    this.stopGatewaySubscription = context.gateway.subscribe(() => {
      if (!this.state || !this.context || !this.context.gateway.snapshot.connected) {
        return;
      }
      void loadSkillWorkshopProposals(this.state, this.context).finally(() => this.requestUpdate());
    });
    if (!this.data?.skillWorkshopLoaded && context.gateway.snapshot.connected) {
      void loadSkillWorkshopProposals(this.state, context).finally(() => this.requestUpdate());
    }
  }

  override disconnectedCallback() {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    if (this.state?.skillWorkshopActionNoticeTimer) {
      globalThis.clearTimeout(this.state.skillWorkshopActionNoticeTimer);
    }
    super.disconnectedCallback();
  }

  override render() {
    return this.state && this.context
      ? renderSkillWorkshopPage(
          this.state,
          { context: this.context, onRevisionRequest: this.onRevisionRequest },
          () => this.requestUpdate(),
        )
      : nothing;
  }
}

if (!customElements.get("openclaw-skill-workshop-page")) {
  customElements.define("openclaw-skill-workshop-page", SkillWorkshopPage);
}
