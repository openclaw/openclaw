import { createMemo, For, Match, onSettled, Show, Switch } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context-types.ts";
import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import type { MentionsCapability } from "../app/mentions.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { projectGateway, projectMentions, projectOverlays } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import {
  sharedAgentIdentityProjection,
  sharedAgentsProjection,
  sharedSessionsRevision,
} from "../lib/reactive/shared-application-projections.ts";
import { registerModalSurface } from "./overlay-registry.ts";
import "../styles/sidebar-menus.css";
import "../styles/sidebar-issues.css";
import type { SidebarAttentionDismissal } from "./sidebar-attention-dismissals.ts";
import {
  sidebarInboxEntryMatchesTab,
  sidebarInboxTabCounts,
  type SidebarAttentionItem,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import {
  SidebarAttentionFocusContext,
  type SidebarAttentionFocus,
  type SidebarAttentionFocusKind,
} from "./sidebar-attention-focus.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";
import "../styles/hub-tabs.css";
import {
  renderSidebarApprovalItem as SidebarApprovalItem,
  SidebarIssueItem,
  renderSidebarMentionItem as SidebarMentionItem,
  renderSidebarScopeUpgradeItem as SidebarScopeUpgradeItem,
  renderSidebarUpdateSurface as SidebarUpdateSurface,
} from "./sidebar-issue-item.tsx";
import { ISSUE_TABS, type IssueTab } from "./sidebar-issues-tabs.ts";
import { renderSidebarOutboxItem as SidebarOutboxItem } from "./sidebar-outbox-item.tsx";
import { HubTabs } from "./solid/hub-tabs.tsx";
import { Icon } from "./solid/icon.tsx";
import "./menu-surface.ts";
import "./tooltip.ts";

registerEnglishCatalog(registerSidebarAttentionEnglish);
export { ScopeUpgradeOwner } from "../app/device-scope-upgrade-owner.runtime.ts";
export type SidebarAttentionPanelPosition = { left: number } & (
  | { anchor: "top"; top: number }
  | { anchor: "bottom"; bottom: number }
);
export type SidebarAttentionPanelParams = {
  entries: readonly SidebarInboxEntry[];
  approvalPending?: boolean;
  onApprovalDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onClose: () => void;
  onDismiss: (dismissal: SidebarAttentionDismissal) => void;
  onKeydown: (event: KeyboardEvent) => void;
  onNavigate: ApplicationContext["navigate"];
  onOpen: (item: SidebarAttentionItem) => void;
  listRef?: (element: HTMLDivElement | null) => void;
  focusRef?: (registry: SidebarAttentionFocus | null) => void;
  onSelectTab: (tab: IssueTab) => void;
  overflowAbove: boolean;
  overflowBelow: boolean;
  panelPosition: SidebarAttentionPanelPosition;
  selectedTab: IssueTab;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
};

/** The mounted Inbox owns its controls; DOM order can change when keyed rows move. */
function createSidebarAttentionFocus(root: () => HTMLElement): SidebarAttentionFocus {
  const targets = new Map<HTMLElement, SidebarAttentionFocusKind>();
  const ordered = (row: boolean) =>
    [...targets]
      .filter(
        ([element, kind]) =>
          element.isConnected &&
          root().contains(element) &&
          (row ? kind !== "control" : kind !== "row-only"),
      )
      .map(([element]) => element)
      .toSorted((left, right) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
  return {
    ref(kind = "control") {
      let element: HTMLElement | undefined;
      onSettled(() => {
        if (!element) {
          return undefined;
        }
        const target = element;
        targets.set(target, kind);
        return () => targets.delete(target);
      });
      return (target) => {
        element = target;
      };
    },
    rows: () => ordered(true),
    controls: () =>
      ordered(false).filter((element) => {
        const closedDetails = element.closest("details:not([open])");
        const insideSummary =
          element.tagName === "SUMMARY" || Boolean(element.parentElement?.closest("summary"));
        return (
          !element.hasAttribute("disabled") &&
          !element.closest("[hidden]") &&
          (!closedDetails || insideSummary)
        );
      }),
  };
}

function SidebarInboxItem(props: {
  entry: SidebarInboxEntry;
  panel: SidebarAttentionPanelParams;
  mentions: MentionsCapability;
  readContext: () => ApplicationContext;
  isMentionDismissing: (id: string) => boolean;
}) {
  const dismiss = () => {
    const dismissal = props.entry.dismissal;
    if (dismissal) {
      props.panel.onDismiss(dismissal);
    }
  };
  return (
    <Switch>
      <Match when={props.entry.type === "outbox" ? props.entry : null}>
        {(entry) => (
          <SidebarOutboxItem
            entry={entry()}
            onNavigate={(route, options) => props.panel.onNavigate(route, options)}
          />
        )}
      </Match>
      <Match when={props.entry.type === "approval" ? props.entry : null}>
        {(entry) => (
          <SidebarApprovalItem
            approval={entry().approval}
            pending={props.panel.approvalPending}
            context={props.readContext()}
            onNavigate={(route, options) => props.panel.onNavigate(route, options)}
            onDecision={props.panel.onApprovalDecision}
          />
        )}
      </Match>
      <Match when={props.entry.type === "attention" ? props.entry : null}>
        {(entry) => (
          <SidebarIssueItem
            item={entry()}
            handlers={{
              get basePath() {
                return props.readContext().basePath;
              },
              get onDismiss() {
                return props.entry.dismissal ? dismiss : undefined;
              },
              onNavigate: (route) => props.panel.onNavigate(route),
              onOpen: (item) => props.panel.onOpen(item),
            }}
          />
        )}
      </Match>
      <Match when={props.entry.type === "mention" ? props.entry : null}>
        {(entry) => (
          <SidebarMentionItem
            mention={entry().mention}
            context={props.readContext()}
            dismissing={props.isMentionDismissing(entry().mention.id)}
            canDismiss={canCallGatewayMethod(
              props.readContext().gateway.snapshot,
              "mentions.dismiss",
              "operator.read",
            )}
            onDismiss={() => void props.mentions.dismiss([entry().mention.id])}
            onNavigate={(route, options) => props.panel.onNavigate(route, options)}
          />
        )}
      </Match>
      <Match when={props.entry.type === "scopeUpgrade" ? props.entry : null}>
        {(entry) => (
          <SidebarScopeUpgradeItem
            state={entry().state}
            onCancel={() => props.readContext().scopeUpgrade.cancel()}
            onDismiss={props.entry.dismissal ? dismiss : undefined}
            onRequest={() => props.readContext().scopeUpgrade.request()}
            onRetry={() => props.readContext().scopeUpgrade.retry()}
          />
        )}
      </Match>
      <Match when={props.entry.type === "update"}>
        <SidebarUpdateSurface
          context={props.readContext()}
          onDismiss={props.entry.dismissal ? dismiss : undefined}
          onNavigate={() => props.panel.onNavigate("updates")}
          watchUpdateProgress={props.panel.watchUpdateProgress}
        />
      </Match>
    </Switch>
  );
}

function inboxEntryIdentity(
  entry: SidebarInboxEntry,
  connectionRevision: number,
  recoveryScope: string | undefined,
): string {
  switch (entry.type) {
    case "approval":
      return JSON.stringify([entry.type, entry.approval.id]);
    case "mention":
      return JSON.stringify([entry.type, entry.mention.id]);
    case "attention":
      return JSON.stringify([entry.type, entry.kind, entry.signature]);
    case "outbox":
      return JSON.stringify([
        entry.type,
        entry.id,
        entry.sessionKey,
        entry.agentId,
        connectionRevision,
        recoveryScope,
      ]);
    case "scopeUpgrade":
    case "update":
      return entry.type;
  }
  return entry satisfies never;
}

export function SidebarAttentionPanel(
  props: SidebarAttentionPanelParams,
  context: ApplicationContext = useApplication(),
  mentionSource: MentionsCapability = context.sidebarAttention.activate(SidebarAttentionStoreOwner),
) {
  let panel!: HTMLElement;
  const focus = createSidebarAttentionFocus(() => panel);
  onSettled(() => {
    const releaseModal = registerModalSurface(panel);
    props.focusRef?.(focus);
    return () => {
      props.listRef?.(null);
      props.focusRef?.(null);
      releaseModal();
    };
  });
  const mentions = projectMentions(mentionSource);
  const gateway = projectGateway(context.gateway);
  const overlays = context.overlays && projectOverlays(context.overlays);
  const agents = context.agents && sharedAgentsProjection(context.agents);
  const sessions = context.sessions && sharedSessionsRevision(context.sessions);
  const identities = context.agentIdentity && sharedAgentIdentityProjection(context.agentIdentity);
  const visibleEntries = createMemo(() =>
    props.entries.filter((entry) => sidebarInboxEntryMatchesTab(entry, props.selectedTab)),
  );
  const visibleDismissals = createMemo(() =>
    visibleEntries().flatMap((entry) => (entry.dismissal ? [entry.dismissal] : [])),
  );
  const visibleMentions = createMemo(() =>
    visibleEntries().flatMap((entry) => (entry.type === "mention" ? [entry.mention.id] : [])),
  );
  const mentionDismissals = createMemo(() =>
    canCallGatewayMethod(gateway.read().snapshot, "mentions.dismiss", "operator.read")
      ? visibleMentions().filter((id) => !mentions.read().dismissing.includes(id))
      : [],
  );
  const hasVisibleDismissals = createMemo(
    () => visibleDismissals().length > 0 || visibleMentions().length > 0,
  );
  const canDismissShown = createMemo(
    () => visibleDismissals().length > 0 || mentionDismissals().length > 0,
  );
  const mentionsTab = createMemo(() => props.selectedTab === "mentions");
  const showMentionStatus = createMemo(
    () =>
      gateway.read().snapshot.phase === "connected" &&
      (mentionsTab() || props.selectedTab === "all") &&
      (mentions.read().error !== null ||
        mentions.read().phase === "loading" ||
        (mentionsTab() && mentions.read().phase === "unavailable")),
  );
  const tabCounts = createMemo(() => sidebarInboxTabCounts(props.entries));
  const panelStyle = createMemo(() => {
    const position = props.panelPosition;
    const offset = position.anchor === "top" ? position.top : position.bottom;
    return `left:${position.left}px;${position.anchor}:${offset}px;--sidebar-issues-panel-${position.anchor}:${offset}px`;
  });
  const readContext = () => {
    gateway.revision();
    overlays?.revision();
    agents?.revision();
    sessions?.revision();
    identities?.revision();
    return context;
  };
  const renderedEntries = createMemo(() => {
    const currentGateway = gateway.read();
    return visibleEntries().map((entry) => ({
      entry,
      identity: inboxEntryIdentity(
        entry,
        currentGateway.connectionRevision,
        currentGateway.snapshot.client?.recoveryScope,
      ),
    }));
  });
  return (
    <SidebarAttentionFocusContext value={focus}>
      <button
        type="button"
        class="sidebar-issues-panel__backdrop"
        aria-label={t("common.close")}
        onClick={() => props.onClose()}
      />
      <openclaw-menu-surface>
        <section
          ref={(element) => (panel = element)}
          id="sidebar-issues-panel"
          class="sidebar-issues-panel"
          role="dialog"
          aria-modal={isMobileNavLayout() ? "true" : undefined}
          aria-labelledby="sidebar-issues-panel-heading"
          style={panelStyle()}
          onKeyDown={(event) => props.onKeydown(event)}
        >
          <div class="sidebar-issues-panel__grabber" aria-hidden="true" />
          <header class="sidebar-issues-panel__header">
            <h2 id="sidebar-issues-panel-heading" class="sidebar-issues-panel__heading">
              <span class="sidebar-issues-panel__heading-icon" aria-hidden="true">
                <Icon name="inbox" />
              </span>
              {t("attention.issues")}
            </h2>
            <div class="sidebar-issues-panel__header-actions">
              <button
                ref={focus.ref()}
                type="button"
                class="btn btn--xs btn--ghost sidebar-issues-panel__dismiss-shown"
                style={hasVisibleDismissals() ? undefined : "visibility:hidden"}
                disabled={!canDismissShown()}
                aria-hidden={hasVisibleDismissals() ? undefined : "true"}
                onClick={() => {
                  for (const dismissal of visibleDismissals()) {
                    props.onDismiss(dismissal);
                  }
                  if (mentionDismissals().length > 0) {
                    void mentionSource.dismiss(mentionDismissals());
                  }
                }}
              >
                {t("attention.dismissShown")}
              </button>
              <openclaw-tooltip prop:content={t("attention.mentions.notifications")}>
                <a
                  ref={focus.ref()}
                  class="sidebar-brand__icon"
                  aria-label={t("attention.mentions.notifications")}
                  href={pathForRoute("notifications", context.basePath)}
                  onClick={(event) =>
                    handleNavigationClick(event, () => props.onNavigate("notifications"))
                  }
                >
                  <Icon name="settings" />
                </a>
              </openclaw-tooltip>
              <button
                ref={focus.ref()}
                type="button"
                class="sidebar-brand__icon sidebar-issues-panel__mobile-close"
                aria-label={t("common.close")}
                onClick={() => props.onClose()}
              >
                <Icon name="x" />
              </button>
            </div>
          </header>
          {/* Header controls and the list bound the tablist, so its tabs are never wrap endpoints. */}
          <HubTabs
            id="sidebar-issues"
            active={props.selectedTab}
            ariaLabel={t("attention.tabs.label")}
            panelId="sidebar-issues-tabpanel"
            class="sidebar-issues-panel__tabs"
            variant="sub"
            tabs={ISSUE_TABS.map((tab) => ({
              value: tab,
              label: t(`attention.tabs.${tab}`),
              count: tabCounts()[tab] || undefined,
            }))}
            onSelect={(tab) => props.onSelectTab(tab)}
          />
          <div class="sidebar-issues-panel__list-wrap">
            <div
              ref={[focus.ref(), (element) => props.listRef?.(element)]}
              id="sidebar-issues-tabpanel"
              class="sidebar-issues-panel__list"
              role="tabpanel"
              aria-labelledby={`sidebar-issues-tab-${props.selectedTab}`}
              tabindex={0}
            >
              <Show when={showMentionStatus()}>
                <div class="sidebar-issues-panel__mentions-note" role="status">
                  <span>
                    {t(
                      mentions.read().error !== null
                        ? "attention.mentions.error"
                        : mentions.read().phase === "loading"
                          ? "attention.mentions.loading"
                          : "attention.mentions.unavailable",
                    )}
                  </span>
                  <Show when={mentions.read().error !== null}>
                    <span>{mentions.read().error}</span>
                    <button
                      ref={focus.ref()}
                      type="button"
                      class="sidebar-issues-panel__action"
                      disabled={mentions.read().phase === "loading"}
                      onClick={() => void mentionSource.refresh()}
                    >
                      {t("attention.mentions.refresh")}
                    </button>
                  </Show>
                </div>
              </Show>
              <Show when={visibleEntries().length === 0 && !showMentionStatus()}>
                <div class="sidebar-issues-panel__empty">
                  <span class="sidebar-issues-panel__empty-icon" aria-hidden="true">
                    <Icon name="inbox" />
                  </span>
                  <strong>
                    {t(mentionsTab() ? "attention.mentions.emptyTitle" : "attention.emptyTitle")}
                  </strong>
                  <span>
                    {t(mentionsTab() ? "attention.mentions.emptyBody" : "attention.emptyBody")}
                  </span>
                </div>
              </Show>
              <For each={renderedEntries()} keyed={(row) => row.identity}>
                {(row) => (
                  <SidebarInboxItem
                    entry={row().entry}
                    panel={props}
                    mentions={mentionSource}
                    readContext={readContext}
                    isMentionDismissing={(id) => mentions.read().dismissing.includes(id)}
                  />
                )}
              </For>
            </div>
            <div
              class="sidebar-issues-panel__overflow-cue sidebar-issues-panel__overflow-cue--top"
              hidden={!props.overflowAbove}
              aria-hidden="true"
            />
            <div
              class="sidebar-issues-panel__overflow-cue sidebar-issues-panel__overflow-cue--bottom"
              hidden={!props.overflowBelow}
              aria-hidden="true"
            />
          </div>
          <Show when={mentionsTab()}>
            <footer class="sidebar-issues-panel__mentions-note">
              <span>{t("attention.mentions.retention")}</span>
            </footer>
          </Show>
        </section>
      </openclaw-menu-surface>
    </SidebarAttentionFocusContext>
  );
}
