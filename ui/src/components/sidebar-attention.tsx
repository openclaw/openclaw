import { createMemo, createSignal, lazy, Loading, onSettled, Show } from "solid-js";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context-types.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { projectGateway, projectSidebarAttention } from "../lib/reactive/application.ts";
import { useApplication, useOptionalApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { showToast } from "../lib/toast.ts";
import "../styles/sidebar-attention-floating.css";
import { sidebarInboxTabCounts, type SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import type { SidebarAttentionPanelPosition } from "./sidebar-attention-panel.runtime.tsx";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerSidebarAttentionEnglish);

export type SidebarAttentionProps = {
  cachedCount?: number;
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
  const Panel = lazy(() => import("./sidebar-attention-panel.runtime.tsx"), {
    export: "SidebarAttentionPanel",
  });
  const panelLoad = createIdleImport(Panel.preload);
  let panelRuntime: Awaited<ReturnType<typeof panelLoad.load>> | undefined;
  let panelTrigger: { element: HTMLElement; scope: ReturnType<typeof routeScope> } | null = null;
  let list: HTMLDivElement | null = null;
  let panelGeneration = 0;
  let disposed = false;
  const count = createMemo(() => props.cachedCount ?? sidebarInboxTabCounts(attention.read()).all);
  const label = createMemo(() =>
    t(count() === 1 ? "attention.issueCount" : "attention.issueCountPlural", {
      count: String(count()),
    }),
  );

  function isCurrentPanel(generation: number, scope: ReturnType<typeof routeScope>) {
    return (
      !disposed && host.isConnected && generation === panelGeneration && scope === routeScope()
    );
  }

  function closePanel(restoreFocus: boolean) {
    const generation = ++panelGeneration;
    const scope = routeScope();
    const trigger = restoreFocus && panelOpen() ? panelTrigger?.element : null;
    setPanelOpen(false);
    panelTrigger = null;
    if (trigger) {
      queueMicrotask(() => {
        if (isCurrentPanel(generation, scope)) {
          trigger.focus();
        }
      });
    }
  }
  const preloadPanel = () => {
    void panelLoad.load().catch(() => undefined);
  };
  async function openPanel(trigger: HTMLElement) {
    const generation = ++panelGeneration;
    const scope = routeScope();
    panelTrigger = { element: trigger, scope };
    let runtime: Awaited<ReturnType<typeof panelLoad.load>>;
    try {
      runtime = await panelLoad.load();
    } catch {
      if (isCurrentPanel(generation, scope)) {
        showToast({
          message: `${t("lazyView.errorTitle")} ${t("lazyView.staleSubtitle")}`,
          severity: "error",
        });
      }
      return;
    }
    if (!isCurrentPanel(generation, scope)) {
      return;
    }
    context.scopeUpgrade.activate(runtime.ScopeUpgradeOwner);
    panelRuntime = runtime;
    setPanelPosition(runtime.sidebarAttentionPanelPosition(trigger));
    setPanelOpen(true);
    queueMicrotask(() => {
      if (isCurrentPanel(generation, scope)) {
        list?.focus();
      }
    });
  }
  function open(item: SidebarAttentionItem) {
    closePanel(false);
    const generation = panelGeneration;
    const scope = routeScope();
    void panelRuntime?.openSidebarAttentionItem(item, context, props.onNavigate, () =>
      isCurrentPanel(generation, scope),
    );
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
    <>
      <span class="sr-only" role="status" aria-live="polite">
        {label()}
      </span>
      <button
        type="button"
        class="sidebar-issues-button"
        disabled={gateway.read().snapshot.phase !== "connected" && attention.read().length === 0}
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
      <Show when={panelOpen()}>
        <Loading>
          <Panel
            entries={attention.read()}
            onClose={() => closePanel(true)}
            onDismiss={(dismissal) => context.sidebarAttention.dismiss(dismissal)}
            onNavigate={(route, options) => {
              closePanel(false);
              (props.onNavigate ?? context.navigate)(route, options);
            }}
            onOpen={open}
            listRef={(element) => (list = element)}
            panelPosition={panelPosition()}
            watchUpdateProgress={props.watchUpdateProgress}
          />
        </Loading>
      </Show>
    </>
  );
}

export const SidebarAttention = defineSolidBridge<SidebarAttentionProps, SidebarAttentionMethods>(
  "openclaw-sidebar-attention",
  (props, host) =>
    useOptionalApplication() ? renderSidebarAttentionContent(props, host) : props.children,
  {
    properties: {
      cachedCount: { default: undefined, attribute: false },
      activeRouteId: { default: undefined, attribute: false },
      onNavigate: { default: undefined, attribute: false },
      watchUpdateProgress: { default: undefined, attribute: false },
    },
    methods: { dismissPanel: (host) => panelDismissals.get(host)?.() ?? false },
    propertyChanged: (host, key) => {
      if (key === "activeRouteId") {
        panelDismissals.get(host)?.();
      }
    },
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
