import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { Errored, Loading, Show, createMemo, createSignal, isPending, onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { Icon } from "../components/solid/icon.tsx";
import {
  acquireBoardProviderForSession,
  boardExists,
  boardProviderCacheKey,
  type BoardViewCallbacks,
} from "../lib/board/provider.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { observeSolidBridgeProperties } from "./control-ui-properties.ts";
import "./control-ui-dashboard.css";

export type PluginSessionDashboardProps = {
  session: BoardGetParams | null;
  client: GatewayBrowserClient | null;
  connected: boolean;
  canMutate: boolean;
  canGrant: boolean;
  presented: boolean;
};

function PluginSessionDashboardContent(
  props: PluginSessionDashboardProps,
  host: SolidBridgeElement<PluginSessionDashboardProps>,
) {
  const context = useOptionalApplication();
  const gateway = context ? projectGateway(context.gateway) : undefined;
  const boardView = createMemo(() => import("../components/board/board-view.tsx"));
  const scope = createMemo(
    () => {
      gateway?.revision();
      return props.client && props.session?.sessionKey.trim()
        ? {
            client: props.client,
            cacheKey: boardProviderCacheKey(props.session),
            presentationScope: context ? gatewayPresentationScope(context.gateway) : undefined,
            session: props.session,
            connected: props.connected,
            canMutate: props.canMutate,
            canGrant: props.canGrant,
          }
        : null;
    },
    {
      equals: (left, right) =>
        left?.client === right?.client &&
        left?.cacheKey === right?.cacheKey &&
        left?.presentationScope === right?.presentationScope,
    },
  );
  const resource = createMemo(() => {
    const current = scope();
    if (!current) {
      return null;
    }
    const lease = acquireBoardProviderForSession(
      current.session,
      current.client,
      current.connected,
      false,
      false,
      current.canMutate,
      current.canGrant,
      current.presentationScope,
    );
    onCleanup(() => lease.release());
    const projection = projectSource(lease.provider, {
      read: (provider) => ({
        snapshot: provider.snapshot$.value,
        appViewGeneration: provider.appViewGeneration,
        hasLoadedSnapshot: provider.hasLoadedSnapshot,
      }),
      subscribe: (provider, notify) => {
        const stopSnapshot = provider.snapshot$.subscribe(notify);
        const stopError = provider.loadError$.subscribe(notify);
        return () => {
          stopSnapshot();
          stopError();
        };
      },
      equality: "revision",
    });
    const callbacks: BoardViewCallbacks = {
      get appViewGeneration() {
        return projection.read().appViewGeneration;
      },
      applyOps: (ops) => lease.provider.applyOps(ops),
      grant: (name, decision) => lease.provider.grant(name, decision),
      selectTab: (activeTabId) => setPresentation((previous) => ({ ...previous, activeTabId })),
      frameLoadFailed: (name) => lease.provider.refreshWidgetFrame(name),
      widgetAppView: (name, revision) => lease.provider.widgetAppView(name, revision),
      refreshWidgetAppView: (name, revision) => lease.provider.refreshWidgetAppView(name, revision),
    };
    return { lease, projection, callbacks };
  });
  // Keep the shared transport and this lease's mutation authority current.
  observeSolidBridgeProperties(
    host,
    ["session", "client", "connected", "canMutate", "canGrant"],
    undefined,
    () => {
      const current = resource();
      if (current && host.client) {
        current.lease.update(host.client, host.connected, {
          canPinWidgets: false,
          canPinMcpApps: false,
          canMutate: host.canMutate,
          canGrant: host.canGrant,
        });
      }
    },
  );
  // Preserve manual choices within a scope; a replacement initializes only after its first snapshot.
  const [presentation, setPresentation] = createSignal<{
    scope: ReturnType<typeof scope>;
    expanded: boolean;
    initialized: boolean;
    activeTabId: string;
  }>((previous) => {
    const current = scope();
    const state = resource()?.projection.read();
    const retained = previous?.scope === current;
    const initialize = state?.hasLoadedSnapshot && (!retained || !previous?.initialized);
    return {
      scope: current,
      expanded: initialize ? boardExists(state.snapshot) : (previous?.expanded ?? false),
      initialized: initialize || (retained && previous?.initialized),
      activeTabId:
        previous &&
        retained &&
        state?.snapshot.tabs.some((tab) => tab.tabId === previous.activeTabId)
          ? previous.activeTabId
          : (state?.snapshot.tabs[0]?.tabId ?? ""),
    };
  });
  const board = createMemo(() => {
    const current = resource();
    const session = props.session;
    const state = current?.projection.read();
    return current && session && state && boardExists(state.snapshot)
      ? { ...current, session, snapshot: state.snapshot }
      : null;
  });
  return (
    <section class="plugin-session-dashboard">
      <button
        type="button"
        class="plugin-session-dashboard__toggle"
        aria-expanded={presentation().expanded ? "true" : "false"}
        onClick={() =>
          setPresentation((previous) => ({
            ...previous,
            initialized: true,
            expanded: !previous.expanded,
          }))
        }
      >
        <span class="plugin-session-dashboard__title">
          <Icon name="kanban" />
          <span>{t("pluginUi.dashboardTitle")}</span>
        </span>
        <span class="plugin-session-dashboard__chevron" aria-hidden="true">
          <Icon name="arrowDown" />
        </span>
      </button>
      <div class="plugin-session-dashboard__body" hidden={!presentation().expanded}>
        <Errored
          fallback={(error, reset) => {
            const message = () => {
              const failure = error();
              return failure instanceof Error ? failure.message : String(failure);
            };
            return (
              <Show when={!isPending(() => boardView())}>
                <p role="alert">{message()}</p>
                <button type="button" onClick={reset}>
                  {t("common.retry")}
                </button>
              </Show>
            );
          }}
        >
          <Loading>
            <Show when={boardView().BoardView} keyed>
              {(BoardView) => (
                <Show
                  when={board()}
                  fallback={
                    <p class="plugin-session-dashboard__empty">{t("pluginUi.dashboardEmpty")}</p>
                  }
                >
                  {(current) => (
                    <BoardView
                      active={presentation().expanded && props.presented}
                      session={current().session}
                      snapshot={current().snapshot}
                      activeTabId={presentation().activeTabId}
                      widgetFrameUrl={(name: string, revision: number) =>
                        current().lease.provider.widgetFrameUrl(name, revision)
                      }
                      callbacks={current().callbacks}
                      canMutate={props.connected && props.canMutate}
                      canGrant={props.connected && props.canGrant}
                    />
                  )}
                </Show>
              )}
            </Show>
          </Loading>
        </Errored>
      </div>
      <Show when={!presentation().expanded && presentation().initialized && !board()}>
        <p class="plugin-session-dashboard__collapsed-empty">{t("pluginUi.dashboardEmpty")}</p>
      </Show>
    </section>
  );
}

export const PluginSessionDashboard = defineSolidBridge<PluginSessionDashboardProps>(
  "openclaw-plugin-session-dashboard",
  PluginSessionDashboardContent,
  {
    properties: {
      session: { default: null, attribute: false },
      client: { default: null, attribute: false },
      connected: { default: false, attribute: false },
      canMutate: { default: false, attribute: false },
      canGrant: { default: false, attribute: false },
      presented: { default: true, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-session-dashboard": SolidBridgeElement<PluginSessionDashboardProps>;
  }
}
