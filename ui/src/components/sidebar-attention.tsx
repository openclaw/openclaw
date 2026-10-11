import { createEffect, createMemo, createSignal, flush, onCleanup, Show, untrack } from "solid-js";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context-types.ts";
import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { projectGateway, projectSidebarAttention } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import "../styles/sidebar-attention-floating.css";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { sidebarInboxTabCounts, type SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import type { SidebarAttentionPanelPosition } from "./sidebar-attention-panel.runtime.tsx";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";
import type { IssueTab } from "./sidebar-issues-tabs.ts";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerSidebarAttentionEnglish);

type PanelRenderer = typeof import("./sidebar-attention-panel.runtime.tsx").SidebarAttentionPanel;
export type SidebarAttentionProps = {
  activeRouteId?: NavigationRouteId;
  onNavigate?: ApplicationContext["navigate"];
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
};

const panelDismissals = new WeakMap<HTMLElement, () => boolean>();

function renderSidebarAttentionContent(props: SidebarAttentionProps, host: HTMLElement) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const attention = projectSidebarAttention(context.sidebarAttention);
  const mentions = context.sidebarAttention.activate(SidebarAttentionStoreController);
  const [panelOpen, setPanelOpen] = createSignal(false);
  const [panelPosition, setPanelPosition] = createSignal<SidebarAttentionPanelPosition>({
    left: 8,
    anchor: "bottom",
    bottom: 8,
  });
  const [selectedTab, setSelectedTab] = createSignal<IssueTab>("all");
  const [overflowAbove, setOverflowAbove] = createSignal(false);
  const [overflowBelow, setOverflowBelow] = createSignal(false);
  const [panelRenderer, setPanelRenderer] = createSignal<PanelRenderer | null>(null);
  const panelLoad = createIdleImport(() => import("./sidebar-attention-panel.runtime.tsx"));
  let panelTrigger: HTMLElement | null = null;
  let panelGeneration = 0;
  let disposed = false;
  const count = createMemo(() => sidebarInboxTabCounts(attention.read()).all);
  const label = createMemo(() =>
    t(count() === 1 ? "attention.issueCount" : "attention.issueCountPlural", {
      count: String(count()),
    }),
  );

  function closePanel(restoreFocus: boolean) {
    const generation = ++panelGeneration;
    const trigger = restoreFocus && panelOpen() ? panelTrigger : null;
    setPanelOpen(false);
    setOverflowAbove(false);
    setOverflowBelow(false);
    panelTrigger = null;
    if (trigger) {
      queueMicrotask(() => {
        if (!disposed && generation === panelGeneration) {
          trigger.focus();
        }
      });
    }
  }
  panelDismissals.set(host, () =>
    untrack(() => {
      const wasOpen = !disposed && panelOpen();
      closePanel(false);
      return wasOpen;
    }),
  );

  const syncOverflowCue = () => {
    const list = host.querySelector<HTMLElement>(".sidebar-issues-panel__list");
    setOverflowAbove(Boolean(list && list.scrollTop > 2));
    setOverflowBelow(Boolean(list && list.scrollHeight - list.scrollTop - list.clientHeight > 2));
  };
  const preloadPanel = () => {
    void panelLoad.load().catch(() => undefined);
  };
  async function openPanel(trigger: HTMLElement) {
    const generation = ++panelGeneration;
    panelTrigger = trigger;
    const runtime = await panelLoad.load();
    if (disposed || !host.isConnected || generation !== panelGeneration) {
      return;
    }
    context.scopeUpgrade.activate(runtime.ScopeUpgradeController);
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(390, globalThis.innerWidth - 16);
    const preferredLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(8, Math.min(preferredLeft, globalThis.innerWidth - width - 8));
    setPanelRenderer(() => runtime.SidebarAttentionPanel);
    setPanelPosition(
      rect.top < globalThis.innerHeight / 2
        ? { left, anchor: "top", top: Math.max(8, rect.bottom + 8) }
        : { left, anchor: "bottom", bottom: Math.max(8, globalThis.innerHeight - rect.top + 8) },
    );
    setSelectedTab("all");
    setPanelOpen(true);
    queueMicrotask(() => {
      if (!disposed && generation === panelGeneration) {
        host.querySelector<HTMLElement>(".sidebar-issues-panel__list")?.focus();
      }
    });
  }
  function selectTab(tab: IssueTab) {
    setSelectedTab(tab);
    queueMicrotask(() =>
      untrack(() => {
        if (disposed || !panelOpen() || selectedTab() !== tab) {
          return;
        }
        const list = host.querySelector<HTMLElement>(".sidebar-issues-panel__list");
        if (list) {
          list.scrollTop = 0;
        }
        syncOverflowCue();
      }),
    );
  }
  async function open(item: SidebarAttentionItem) {
    closePanel(false);
    if (item.action.kind === "navigate") {
      props.onNavigate?.(item.action.routeId);
      return;
    }
    const { custodianAlertStore } = await import("../pages/custodian/custodian-alert-store.ts");
    custodianAlertStore.present(item.action.alert);
    if (canCallGatewayMethod(context.gateway.snapshot, "openclaw.chat", "operator.admin")) {
      window.dispatchEvent(
        new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }),
      );
    } else {
      (props.onNavigate ?? context.navigate)("custodian");
    }
  }
  const handleOutsideInteraction = (event: PointerEvent | KeyboardEvent) => {
    const dismiss =
      event instanceof KeyboardEvent
        ? event.key === "Escape" && !panelOpen() && !event.defaultPrevented
        : !event.composedPath().includes(host);
    if (!dismiss) {
      return;
    }
    if (event instanceof KeyboardEvent && panelTrigger) {
      event.preventDefault();
      event.stopPropagation();
    }
    closePanel(false);
  };
  const handleWindowBlur = () => {
    let active = document.activeElement;
    if (host.contains(active)) {
      return;
    }
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    if (active instanceof HTMLIFrameElement) {
      closePanel(false);
    }
  };
  const handlePanelKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel(true);
      return;
    }
    if (event.key !== "Tab" || !(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "summary, button, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((element) => {
      const closedDetails = element.closest("details:not([open])");
      const insideSummary =
        element.tagName === "SUMMARY" || Boolean(element.parentElement?.closest("summary"));
      return (
        !element.hasAttribute("disabled") &&
        !element.closest("[hidden]") &&
        (!closedDetails || insideSummary)
      );
    });
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
  async function decideApproval(event: Event, approvalId: string, decision: ExecApprovalDecision) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const focusOrder = Array.from(host.querySelectorAll<HTMLElement>("[data-issue-row-focus]"));
    const row = target.closest<HTMLElement>("[data-approval-id]");
    const rowFocus = row?.querySelector<HTMLElement>("[data-issue-row-focus]") ?? null;
    const rowIndex = rowFocus ? focusOrder.indexOf(rowFocus) : 0;
    const generation = panelGeneration;
    await context.overlays.decideApproval(decision, approvalId);
    flush();
    if (disposed || generation !== panelGeneration || target.isConnected) {
      return;
    }
    const remaining = Array.from(host.querySelectorAll<HTMLElement>("[data-issue-row-focus]"));
    remaining[Math.min(Math.max(rowIndex, 0), remaining.length - 1)]?.focus();
  }

  let previousRoute = untrack(() => props.activeRouteId);
  createEffect(
    () => props.activeRouteId,
    (route) => {
      if (previousRoute !== undefined && previousRoute !== route) {
        closePanel(false);
      }
      previousRoute = route;
    },
  );
  createEffect(
    () => [panelOpen(), selectedTab(), attention.read()],
    ([isOpen]) => {
      if (isOpen) {
        syncOverflowCue();
      }
    },
  );
  preloadPanel();
  document.addEventListener("pointerdown", handleOutsideInteraction, true);
  document.addEventListener("keydown", handleOutsideInteraction, true);
  window.addEventListener("blur", handleWindowBlur);
  onCleanup(() => {
    disposed = true;
    panelGeneration += 1;
    panelDismissals.delete(host);
    document.removeEventListener("pointerdown", handleOutsideInteraction, true);
    document.removeEventListener("keydown", handleOutsideInteraction, true);
    window.removeEventListener("blur", handleWindowBlur);
    panelLoad.dispose();
  });

  return (
    <Show when={gateway.read().snapshot.phase === "connected" || attention.read().length > 0}>
      <span class="sr-only" role="status" aria-live="polite">
        {label()}
      </span>
      <button
        type="button"
        class="sidebar-issues-button"
        aria-expanded={panelOpen() ? "true" : "false"}
        aria-haspopup="dialog"
        aria-controls="sidebar-issues-panel"
        aria-label={label()}
        onPointerEnter={preloadPanel}
        onFocus={preloadPanel}
        onPointerDown={preloadPanel}
        onClick={(event) => {
          if (panelOpen()) {
            closePanel(true);
          } else {
            void openPanel(event.currentTarget);
          }
        }}
      >
        <span class="sidebar-issues-button__icon" aria-hidden="true">
          <Icon name="inbox" />
        </span>
        <Show when={count() > 0}>
          <span class="sidebar-issues-button__count" aria-hidden="true">
            {count() > 9 ? "9+" : count()}
          </span>
        </Show>
      </button>
      <Show when={panelOpen() && panelRenderer()} keyed>
        {(Panel) => (
          <Panel
            context={context}
            mentions={mentions}
            entries={attention.read()}
            onApprovalDecision={(event, id, decision) => void decideApproval(event, id, decision)}
            onClose={() => closePanel(true)}
            onDismiss={(dismissal) => context.sidebarAttention.dismiss(dismissal)}
            onKeydown={handlePanelKeydown}
            onNavigate={(route, options) => {
              closePanel(false);
              (props.onNavigate ?? context.navigate)(route, options);
            }}
            onOpen={(item) => void open(item)}
            onScroll={syncOverflowCue}
            onSelectTab={selectTab}
            overflowAbove={overflowAbove()}
            overflowBelow={overflowBelow()}
            panelPosition={panelPosition()}
            selectedTab={selectedTab()}
            watchUpdateProgress={props.watchUpdateProgress}
          />
        )}
      </Show>
    </Show>
  );
}

export const SidebarAttention = defineSolidBridge<
  SidebarAttentionProps,
  { dismissPanel(): boolean }
>("openclaw-sidebar-attention", renderSidebarAttentionContent, {
  properties: {
    activeRouteId: { default: undefined, attribute: false },
    onNavigate: { default: undefined, attribute: false },
    watchUpdateProgress: { default: undefined, attribute: false },
  },
  methods: { dismissPanel: (host) => panelDismissals.get(host)?.() ?? false },
});
