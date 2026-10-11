import { createEffect, createMemo, For, Match, Show, Switch, untrack } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context-types.ts";
import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import type { MentionsCapability } from "../app/mentions.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectGateway, projectMentions, projectOverlays } from "../lib/reactive/application.ts";
import {
  projectAgents,
  projectAgentIdentity,
  projectSessions,
} from "../lib/reactive/domain-capabilities.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import "../styles/sidebar-menus.css";
import "../styles/sidebar-issues.css";
import type { SidebarAttentionDismissal } from "./sidebar-attention-dismissals.ts";
import {
  sidebarInboxEntryMatchesTab,
  sidebarInboxTabCounts,
  type SidebarAttentionItem,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
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
import { Icon } from "./solid/icon.tsx";
import { syncTabGroupLabel } from "./web-awesome-tabs.ts";
import "./menu-surface.ts";
import "./tooltip.ts";

registerEnglishCatalog(registerSidebarAttentionEnglish);
export { ScopeUpgradeController } from "../app/device-scope-upgrade-controller.runtime.ts";
export type SidebarAttentionPanelPosition = { left: number } & (
  | { anchor: "top"; top: number }
  | { anchor: "bottom"; bottom: number }
);
export type SidebarAttentionPanelParams = {
  context: ApplicationContext;
  mentions: MentionsCapability;
  entries: readonly SidebarInboxEntry[];
  onApprovalDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onClose: () => void;
  onDismiss: (dismissal: SidebarAttentionDismissal) => void;
  onKeydown: (event: KeyboardEvent) => void;
  onNavigate: ApplicationContext["navigate"];
  onOpen: (item: SidebarAttentionItem) => void;
  onScroll: () => void;
  onSelectTab: (tab: IssueTab) => void;
  overflowAbove: boolean;
  overflowBelow: boolean;
  panelPosition: SidebarAttentionPanelPosition;
  selectedTab: IssueTab;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
};

function SidebarInboxItem(props: {
  entry: SidebarInboxEntry;
  panel: SidebarAttentionPanelParams;
  readContext: () => ApplicationContext;
  isMentionDismissing: (id: string) => boolean;
}) {
  const outbox = createMemo(() => {
    const entry = props.entry;
    return entry.type === "outbox" ? entry : null;
  });
  const approval = createMemo(() => {
    const entry = props.entry;
    return entry.type === "approval" ? entry : null;
  });
  const attention = createMemo(() => {
    const entry = props.entry;
    return entry.type === "attention" ? entry : null;
  });
  const mention = createMemo(() => {
    const entry = props.entry;
    return entry.type === "mention" ? entry : null;
  });
  const scopeUpgrade = createMemo(() => {
    const entry = props.entry;
    return entry.type === "scopeUpgrade" ? entry : null;
  });
  const dismiss = () => {
    const dismissal = props.entry.dismissal;
    if (dismissal) {
      props.panel.onDismiss(dismissal);
    }
  };
  return (
    <Switch>
      <Match when={outbox()}>
        {(entry) => (
          <SidebarOutboxItem
            entry={entry()}
            context={props.readContext()}
            onNavigate={(route, options) => props.panel.onNavigate(route, options)}
          />
        )}
      </Match>
      <Match when={approval()}>
        {(entry) => (
          <SidebarApprovalItem
            approval={entry().approval}
            context={props.readContext()}
            onNavigate={(route, options) => props.panel.onNavigate(route, options)}
            onDecision={(event, id, decision) =>
              props.panel.onApprovalDecision(event, id, decision)
            }
          />
        )}
      </Match>
      <Match when={attention()}>
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
      <Match when={mention()}>
        {(entry) => (
          <SidebarMentionItem
            mention={entry().mention}
            context={props.readContext()}
            dismissing={props.isMentionDismissing(entry().mention.id)}
            onDismiss={() => void props.panel.mentions.dismiss([entry().mention.id])}
            onNavigate={(route, options) => props.panel.onNavigate(route, options)}
          />
        )}
      </Match>
      <Match when={scopeUpgrade()}>
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

export function SidebarAttentionPanel(props: SidebarAttentionPanelParams) {
  const context = untrack(() => props.context);
  const mentions = projectMentions(untrack(() => props.mentions));
  const gateway = projectGateway(context.gateway);
  const overlays = context.overlays && projectOverlays(context.overlays);
  const agents = context.agents && projectAgents(context.agents);
  const sessions = context.sessions && projectSessions(context.sessions);
  const identities =
    context.agentIdentity &&
    projectAgentIdentity({ identities: context.agentIdentity, agentId: null });
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
    visibleMentions().filter((id) => !mentions.read().dismissing.includes(id)),
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
  let tabGroup: HTMLElement | undefined;
  createEffect(
    () => t("attention.tabs.label"),
    (label) => syncTabGroupLabel(tabGroup, label),
  );
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
    <>
      <button
        type="button"
        class="sidebar-issues-panel__backdrop"
        aria-label={t("common.close")}
        onClick={() => props.onClose()}
      />
      <openclaw-menu-surface>
        <section
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
                    void props.mentions.dismiss(mentionDismissals());
                  }
                }}
              >
                {t("attention.dismissShown")}
              </button>
              <openclaw-tooltip prop:content={t("attention.mentions.notifications")}>
                <a
                  class="sidebar-brand__icon"
                  aria-label={t("attention.mentions.notifications")}
                  href={pathForRoute("notifications", props.context.basePath)}
                  onClick={(event) => {
                    if (!shouldHandleNavigationClick(event)) {
                      return;
                    }
                    event.preventDefault();
                    props.onNavigate("notifications");
                  }}
                >
                  <Icon name="settings" />
                </a>
              </openclaw-tooltip>
              <button
                type="button"
                class="sidebar-brand__icon sidebar-issues-panel__mobile-close"
                aria-label={t("common.close")}
                onClick={() => props.onClose()}
              >
                <Icon name="x" />
              </button>
            </div>
          </header>
          <wa-tab-group
            ref={(element) => {
              tabGroup = element;
            }}
            class="hub-tabs hub-tabs--sub sidebar-issues-hub-tabs sidebar-issues-panel__tabs"
            aria-label={t("attention.tabs.label")}
            prop:active={props.selectedTab}
            activation="manual"
            without-scroll-controls
          >
            <For each={ISSUE_TABS}>
              {(tab) => {
                const activate = (event: Event, keyboard = false) => {
                  if (tab === props.selectedTab) {
                    return;
                  }
                  if (keyboard) {
                    event.preventDefault();
                  }
                  props.onSelectTab(tab);
                };
                return (
                  <wa-tab
                    id={`sidebar-issues-tab-${tab}`}
                    panel={tab}
                    aria-controls="sidebar-issues-tabpanel"
                    class="hub-tab"
                    prop:active={props.selectedTab === tab}
                    tabindex={props.selectedTab === tab ? 0 : -1}
                    aria-selected={props.selectedTab === tab ? "true" : "false"}
                    onClick={(event) => {
                      if (event.detail > 0 || event.isTrusted) {
                        activate(event);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (!event.repeat && (event.key === "Enter" || event.key === " ")) {
                        activate(event, true);
                      }
                    }}
                  >
                    {t(`attention.tabs.${tab}`)}
                    <Show when={tabCounts()[tab] > 0}>
                      <span class="hub-tab__badge hub-tab__badge--count">{tabCounts()[tab]}</span>
                    </Show>
                  </wa-tab>
                );
              }}
            </For>
          </wa-tab-group>
          <div class="sidebar-issues-panel__list-wrap">
            <div
              id="sidebar-issues-tabpanel"
              class="sidebar-issues-panel__list"
              role="tabpanel"
              aria-labelledby={`sidebar-issues-tab-${props.selectedTab}`}
              tabindex={0}
              onScroll={() => props.onScroll()}
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
                      type="button"
                      class="sidebar-issues-panel__action"
                      disabled={mentions.read().phase === "loading"}
                      onClick={() => void props.mentions.refresh()}
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
    </>
  );
}
