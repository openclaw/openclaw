import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context-types.ts";
import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import type { MentionsCapability } from "../app/mentions.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { isCustodianPanelAvailable } from "../app/panel-availability.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { bindSheetDismissGesture, slideSheetOut } from "../lib/motion/sheet-dismiss.ts";
import { projectGateway, projectMentions, projectOverlays } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createScrollStateRef } from "../lib/reactive/scroll-state.ts";
import {
  sharedAgentIdentityProjection,
  sharedAgentsProjection,
  sharedSessionsRevision,
} from "../lib/reactive/shared-application-projections.ts";
import { createTimeout } from "../lib/reactive/timers.ts";
import { showToast } from "../lib/toast.ts";
import { createApprovalDecisionPresentation } from "./approval-decision-presentation.ts";
import { registerModalSurface } from "./overlay-registry.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
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
import { Menu, type MenuItem } from "./solid/menu.tsx";
import "./menu-surface.ts";

registerEnglishCatalog(registerSidebarAttentionEnglish);
export { ScopeUpgradeOwner } from "../app/device-scope-upgrade-owner.runtime.ts";
export type SidebarAttentionPanelPosition = { left: number } & (
  | { anchor: "top"; top: number }
  | { anchor: "bottom"; bottom: number }
);
export function sidebarAttentionPanelPosition(trigger: HTMLElement): SidebarAttentionPanelPosition {
  const rect = trigger.getBoundingClientRect();
  const rail = !trigger.closest(".shell--mobile-nav") ? trigger.closest(".sidebar-rail") : null;
  const width = Math.min(390, globalThis.innerWidth - 16);
  const preferredLeft = rail
    ? rail.getBoundingClientRect().right + 8
    : rect.left + rect.width / 2 - width / 2;
  const left = Math.max(8, Math.min(preferredLeft, globalThis.innerWidth - width - 8));
  return rect.top < globalThis.innerHeight / 2
    ? { left, anchor: "top", top: Math.max(8, rail ? rect.top : rect.bottom + 8) }
    : {
        left,
        anchor: "bottom",
        bottom: Math.max(
          8,
          rail ? globalThis.innerHeight - rect.bottom + 4 : globalThis.innerHeight - rect.top + 8,
        ),
      };
}

export async function openSidebarAttentionItem(
  item: SidebarAttentionItem,
  context: ApplicationContext,
  onNavigate: ApplicationContext["navigate"] | undefined,
  isCurrent: () => boolean,
): Promise<void> {
  if (item.action.kind === "navigate") {
    onNavigate?.(item.action.routeId);
    return;
  }
  if (
    item.action.kind === "openClawIdBrowserApproval" ||
    item.action.kind === "openClawIdRecovery"
  ) {
    const client = context.gateway.snapshot.client;
    try {
      const { openOwnerInboxAction } = await import("../lib/openclaw-id/open-browser-approval.ts");
      await openOwnerInboxAction(
        context,
        item.action,
        () => isCurrent() && client === context.gateway.snapshot.client,
      );
    } catch (error) {
      showToast({ message: formatUiError(error), severity: "error" });
    } finally {
      if (item.action.kind === "openClawIdRecovery") {
        context.sidebarAttention.refreshOpenClawId();
      }
    }
    return;
  }
  try {
    const { custodianAlertStore } = await import("../pages/custodian/custodian-alert-store.ts");
    if (!isCurrent()) {
      return;
    }
    custodianAlertStore.present(item.action.alert);
    if (isCustodianPanelAvailable(context.gateway)) {
      window.dispatchEvent(
        new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }),
      );
    } else {
      (onNavigate ?? context.navigate)("custodian");
    }
  } catch (error) {
    if (isCurrent()) {
      showToast({ message: formatUiError(error), severity: "error" });
    }
  }
}

export type SidebarAttentionPanelParams = {
  entries: readonly SidebarInboxEntry[];
  onClose: () => void;
  onDismiss: (dismissal: SidebarAttentionDismissal) => void;
  onNavigate: ApplicationContext["navigate"];
  onOpen: (item: SidebarAttentionItem) => void;
  listRef?: (element: HTMLDivElement | null) => void;
  panelPosition: SidebarAttentionPanelPosition;
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
    add(element, kind = "control") {
      targets.set(element, kind);
    },
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
  approvalPending: boolean;
  onApprovalDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
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
            pending={props.approvalPending}
            context={props.readContext()}
            onNavigate={(route, options) => props.panel.onNavigate(route, options)}
            onDecision={props.onApprovalDecision}
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
              onNavigate: (route, options) => props.panel.onNavigate(route, options),
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
  const [selectedTab, setSelectedTab] = createSignal<IssueTab>("all");
  const [overflowAbove, setOverflowAbove] = createSignal(false);
  const [overflowBelow, setOverflowBelow] = createSignal(false);
  let list: HTMLDivElement | null = null;
  const syncOverflowCue = (element: HTMLElement) => {
    setOverflowAbove(element.scrollTop > 2);
    setOverflowBelow(element.scrollHeight - element.scrollTop - element.clientHeight > 2);
  };
  const observeListScroll = createScrollStateRef(syncOverflowCue, { content: () => props.entries });
  const selectTab = (tab: IssueTab) => {
    setSelectedTab(tab);
    queueMicrotask(() => {
      if (list?.isConnected && selectedTab() === tab) {
        list.scrollTop = 0;
        syncOverflowCue(list);
      }
    });
  };
  let panel!: HTMLElement;
  let backdrop: HTMLElement | undefined;
  let grabber: HTMLElement | undefined;
  let closing = false;
  let headerMenuOpen = false;
  const focus = createSidebarAttentionFocus(() => panel);
  const approvalDecision = createApprovalDecisionPresentation();
  let active = true;
  const decideApproval = async (
    event: Event,
    approvalId: string,
    decision: ExecApprovalDecision,
  ) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const row = target.closest<HTMLElement>("[data-approval-id]");
    const rowIndex = focus.rows().findIndex((element) => row?.contains(element));
    await approvalDecision.run(context.overlays.decideApproval(decision, approvalId));
    onSettled(() => {
      if (!active || !panel.isConnected || target.isConnected) {
        return;
      }
      const remaining = focus.rows();
      remaining[Math.min(Math.max(rowIndex, 0), remaining.length - 1)]?.focus();
    });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // An open menu handles Escape before the panel.
      if (!headerMenuOpen) {
        event.preventDefault();
        props.onClose();
      }
      return;
    }
    if (event.key !== "Tab" || !(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    const rows = focus.controls();
    const first = rows[0];
    const last = rows.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  // On phones the panel is a bottom sheet: tapping outside or swiping the grabber
  // slides it away before it closes.
  const slideOutAndClose = () => {
    if (closing) {
      return;
    }
    closing = true;
    void (isMobileNavLayout() ? slideSheetOut(panel, backdrop) : Promise.resolve()).then(() =>
      props.onClose(),
    );
  };
  onSettled(() => {
    const releaseModal = registerModalSurface(panel);
    const stopApprovals = context.overlays?.subscribe((snapshot) => {
      if (!snapshot.approvalBusy) {
        approvalDecision.retire();
      }
    });
    const releaseGesture =
      isMobileNavLayout() && grabber
        ? bindSheetDismissGesture({
            surface: panel,
            handle: grabber,
            backdrop: () => backdrop,
            dismiss: () => props.onClose(),
          })
        : undefined;
    return () => {
      list = null;
      props.listRef?.(null);
      active = false;
      approvalDecision.retire();
      stopApprovals?.();
      releaseModal();
      releaseGesture?.();
    };
  });
  const mentions = projectMentions(mentionSource);
  const gateway = projectGateway(context.gateway);
  const overlays = context.overlays && projectOverlays(context.overlays);
  const agents = context.agents && sharedAgentsProjection(context.agents);
  const sessions = context.sessions && sharedSessionsRevision(context.sessions);
  const identities = context.agentIdentity && sharedAgentIdentityProjection(context.agentIdentity);
  const visibleEntries = createMemo(() =>
    props.entries.filter((entry) => sidebarInboxEntryMatchesTab(entry, selectedTab())),
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
  const canDismissShown = createMemo(
    () => visibleDismissals().length > 0 || mentionDismissals().length > 0,
  );
  const dismissShown = () => {
    for (const dismissal of visibleDismissals()) {
      props.onDismiss(dismissal);
    }
    if (mentionDismissals().length > 0) {
      void mentionSource.dismiss(mentionDismissals());
    }
  };
  const headerMenuItems = createMemo((): MenuItem[] => [
    {
      id: "notifications",
      label: t("attention.mentions.notifications"),
      icon: <Icon name="settings" />,
      href: pathForRoute("notifications", context.basePath),
    },
    ...(canDismissShown()
      ? [
          {
            id: "dismiss-shown",
            label: t("attention.dismissShown"),
            icon: <Icon name="checkCheck" />,
          },
        ]
      : []),
  ]);
  const mentionsTab = createMemo(() => selectedTab() === "mentions");
  const mentionsShown = createMemo(
    () =>
      gateway.read().snapshot.phase === "connected" && (mentionsTab() || selectedTab() === "all"),
  );
  // Loading stands in only for an empty list; loaded rows stay put while mentions refresh.
  const mentionsLoading = createMemo(
    () => mentionsShown() && mentions.read().phase === "loading" && visibleEntries().length === 0,
  );
  // Fast loads settle before the indicator appears, so it never flashes; each load re-arms it.
  const [loadingDue, setLoadingDue] = createSignal(() => {
    mentionsLoading();
    return false;
  });
  createTimeout(
    () => setLoadingDue(true),
    () => (mentionsLoading() ? 300 : undefined),
  );
  const showMentionStatus = createMemo(
    () =>
      mentionsShown() &&
      (mentions.read().error !== null ||
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
        ref={(element) => (backdrop = element)}
        type="button"
        class="sidebar-issues-panel__backdrop"
        aria-label={t("common.close")}
        onClick={slideOutAndClose}
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
          onKeyDown={handleKeyDown}
        >
          <div
            ref={(element) => (grabber = element)}
            class="sidebar-issues-panel__grabber"
            aria-hidden="true"
          />
          <header class="sidebar-issues-panel__header">
            <h2 id="sidebar-issues-panel-heading" class="sidebar-issues-panel__heading">
              {t("attention.issues")}
            </h2>
            <div class="sidebar-issues-panel__header-actions">
              <Menu
                id="sidebar-issues-actions"
                label={t("browser.moreActions")}
                pointerFocus="trigger"
                placement="bottom-end"
                triggerClass="sidebar-brand__icon sidebar-issues-panel__more"
                trigger={<Icon name="moreHorizontal" />}
                items={headerMenuItems()}
                ref={(handle) => {
                  if (handle.overlay.trigger) {
                    focus.add(handle.overlay.trigger);
                  }
                }}
                onOpenChange={(open) => {
                  headerMenuOpen = open;
                }}
                onNavigate={() => props.onNavigate("notifications")}
                onSelect={(item) => {
                  if (item.id === "dismiss-shown") {
                    dismissShown();
                  }
                }}
              />
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
            active={selectedTab()}
            ariaLabel={t("attention.tabs.label")}
            panelId="sidebar-issues-tabpanel"
            class="sidebar-issues-panel__tabs"
            variant="sub"
            tabs={ISSUE_TABS.map((tab) => ({
              value: tab,
              label: t(`attention.tabs.${tab}`),
              count: tabCounts()[tab] || undefined,
            }))}
            onSelect={selectTab}
          />
          <div class="sidebar-issues-panel__list-wrap">
            <div
              ref={[
                focus.ref(),
                (element) => {
                  list = element;
                  observeListScroll(element);
                  props.listRef?.(element);
                },
              ]}
              id="sidebar-issues-tabpanel"
              class="sidebar-issues-panel__list"
              role="tabpanel"
              aria-labelledby={`sidebar-issues-tab-${selectedTab()}`}
              tabindex={0}
            >
              <Show when={showMentionStatus()}>
                <div class="sidebar-issues-panel__mentions-note" role="status">
                  <span>
                    {t(
                      mentions.read().error !== null
                        ? "attention.mentions.error"
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
              <Show when={mentionsLoading() && loadingDue()}>
                <div class="sidebar-issues-panel__loading" role="status">
                  <span class="btn__spinner" aria-hidden="true" />
                  <span class="sr-only">{t("attention.mentions.loading")}</span>
                </div>
              </Show>
              <Show
                when={visibleEntries().length === 0 && !mentionsLoading() && !showMentionStatus()}
              >
                <div class="sidebar-issues-panel__empty">
                  <span class="sidebar-issues-panel__empty-icon" aria-hidden="true">
                    <Icon name="inbox" />
                  </span>
                  <strong>
                    {t(mentionsTab() ? "attention.mentions.emptyTitle" : "attention.emptyTitle")}
                  </strong>
                  <Show when={mentionsTab()}>
                    <span>{t("attention.mentions.emptyBody")}</span>
                  </Show>
                </div>
              </Show>
              <For each={renderedEntries()} keyed={(row) => row.identity}>
                {(row) => (
                  <SidebarInboxItem
                    entry={row().entry}
                    panel={props}
                    approvalPending={approvalDecision.deciding()}
                    onApprovalDecision={(event, id, decision) =>
                      void decideApproval(event, id, decision)
                    }
                    mentions={mentionSource}
                    readContext={readContext}
                    isMentionDismissing={(id) => mentions.read().dismissing.includes(id)}
                  />
                )}
              </For>
            </div>
            <div
              class="sidebar-issues-panel__overflow-cue sidebar-issues-panel__overflow-cue--top"
              hidden={!overflowAbove()}
              aria-hidden="true"
            />
            <div
              class="sidebar-issues-panel__overflow-cue sidebar-issues-panel__overflow-cue--bottom"
              hidden={!overflowBelow()}
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
