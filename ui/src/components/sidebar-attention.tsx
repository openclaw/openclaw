import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context-types.ts";
import type { ExecApprovalDecision } from "../app/exec-approval.ts";
import { isCustodianPanelAvailable } from "../app/panel-availability.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { projectGateway, projectSidebarAttention } from "../lib/reactive/application.ts";
import { useApplication, useOptionalApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createScrollStateRef } from "../lib/reactive/scroll-state.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import "../styles/sidebar-attention-floating.css";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { sidebarInboxTabCounts, type SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import type { SidebarAttentionFocus } from "./sidebar-attention-focus.ts";
import type { SidebarAttentionPanelPosition } from "./sidebar-attention-panel.runtime.tsx";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";
import type { IssueTab } from "./sidebar-issues-tabs.ts";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerSidebarAttentionEnglish);

type PanelRenderer = typeof import("./sidebar-attention-panel.runtime.tsx").SidebarAttentionPanel;
export type SidebarAttentionProps = {
  activeRouteId?: NavigationRouteId;
  onNavigate?: ApplicationContext["navigate"];
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
};

export type SidebarAttentionMethods = { dismissPanel(): boolean };
export type SidebarAttentionElement = SolidBridgeElement<
  SidebarAttentionProps,
  SidebarAttentionMethods
>;

const panelDismissals = new WeakMap<HTMLElement, () => boolean>();

function renderSidebarAttentionContent(props: SidebarAttentionProps, host: HTMLElement) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const attention = projectSidebarAttention(context.sidebarAttention);
  context.sidebarAttention.activate(SidebarAttentionStoreOwner);
  const routeId = createMemo(() => props.activeRouteId);
  const routeScope = createMemo(() => ({ routeId: routeId() }));
  // Navigation retires both the open panel and an in-flight lazy open.
  const [panelOpen, setPanelOpen] = createSignal(() => {
    routeScope();
    return false;
  });
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
  let panelTrigger: { element: HTMLElement; scope: ReturnType<typeof routeScope> } | null = null;
  let list: HTMLDivElement | null = null;
  let panelFocus: SidebarAttentionFocus | null = null;
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
    const scope = routeScope();
    const trigger = restoreFocus && panelOpen() ? panelTrigger?.element : null;
    setPanelOpen(false);
    setOverflowAbove(false);
    setOverflowBelow(false);
    panelTrigger = null;
    if (trigger) {
      queueMicrotask(() => {
        if (!disposed && generation === panelGeneration && scope === routeScope()) {
          trigger.focus();
        }
      });
    }
  }
  const syncOverflowCue = (element: HTMLElement) => {
    setOverflowAbove(element.scrollTop > 2);
    setOverflowBelow(element.scrollHeight - element.scrollTop - element.clientHeight > 2);
  };
  const observeListScroll = createScrollStateRef(syncOverflowCue, {
    presented: panelOpen,
    content: attention.revision,
  });
  const preloadPanel = () => {
    void panelLoad.load().catch(() => undefined);
  };
  async function openPanel(trigger: HTMLElement) {
    const generation = ++panelGeneration;
    const scope = routeScope();
    panelTrigger = { element: trigger, scope };
    const runtime = await panelLoad.load();
    if (disposed || !host.isConnected || generation !== panelGeneration || scope !== routeScope()) {
      return;
    }
    context.scopeUpgrade.activate(runtime.ScopeUpgradeOwner);
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
      if (!disposed && generation === panelGeneration && scope === routeScope()) {
        list?.focus();
      }
    });
  }
  function selectTab(tab: IssueTab) {
    setSelectedTab(tab);
    queueMicrotask(() => {
      if (disposed || !panelOpen() || selectedTab() !== tab) {
        return;
      }
      if (list) {
        list.scrollTop = 0;
        syncOverflowCue(list);
      }
    });
  }
  async function open(item: SidebarAttentionItem) {
    closePanel(false);
    if (item.action.kind === "navigate") {
      props.onNavigate?.(item.action.routeId);
      return;
    }
    const { custodianAlertStore } = await import("../pages/custodian/custodian-alert-store.ts");
    custodianAlertStore.present(item.action.alert);
    if (isCustodianPanelAvailable(context.gateway)) {
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
    if (event instanceof KeyboardEvent && panelTrigger?.scope === routeScope()) {
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
    const rows = panelFocus?.controls() ?? [];
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
    const focusOrder = panelFocus?.rows() ?? [];
    const row = target.closest<HTMLElement>("[data-approval-id]");
    const rowIndex = focusOrder.findIndex((element) => row?.contains(element));
    const generation = panelGeneration;
    await context.overlays.decideApproval(decision, approvalId);
    onSettled(() => {
      if (disposed || generation !== panelGeneration || target.isConnected) {
        return;
      }
      const remaining = panelFocus?.rows() ?? [];
      remaining[Math.min(Math.max(rowIndex, 0), remaining.length - 1)]?.focus();
    });
  }

  onSettled(() => {
    panelDismissals.set(host, () => {
      const wasOpen = !disposed && panelOpen();
      closePanel(false);
      return wasOpen;
    });
    const stopPointer = listen(document, "pointerdown", handleOutsideInteraction, true);
    const stopKeydown = listen(document, "keydown", handleOutsideInteraction, true);
    const stopBlur = listen(window, "blur", handleWindowBlur);
    return () => {
      stopPointer();
      stopKeydown();
      stopBlur();
      disposed = true;
      panelGeneration += 1;
      panelDismissals.delete(host);
      panelLoad.dispose();
    };
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
            listRef={(element) => {
              list = element;
              if (element) {
                observeListScroll(element);
              }
            }}
            focusRef={(registry) => (panelFocus = registry)}
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

export const SidebarAttention = defineSolidBridge<SidebarAttentionProps, SidebarAttentionMethods>(
  "openclaw-sidebar-attention",
  (props, host) =>
    useOptionalApplication() ? renderSidebarAttentionContent(props, host) : props.children,
  {
    properties: {
      activeRouteId: { default: undefined, attribute: false },
      onNavigate: { default: undefined, attribute: false },
      watchUpdateProgress: { default: undefined, attribute: false },
    },
    methods: { dismissPanel: (host) => panelDismissals.get(host)?.() ?? false },
    disconnected: (host) => {
      queueMicrotask(() => {
        // A same-turn sidebar move retains intent; a detached Inbox retires it.
        if (!host.isConnected) {
          panelDismissals.get(host)?.();
        }
      });
    },
  },
);
