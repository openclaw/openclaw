import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { Icon } from "../components/solid/icon.tsx";
import {
  acquireBoardProviderForSession,
  boardExists,
  boardProviderCacheKey,
  type BoardViewCallbacks,
} from "../lib/board/provider.ts";
import { projectBoardProvider } from "../lib/reactive/domain-board.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import "./control-ui-dashboard.css";

export type PluginSessionDashboardProps = {
  session: BoardGetParams | null;
  client: GatewayBrowserClient | null;
  connected: boolean;
  canMutate: boolean;
  canGrant: boolean;
  presented: boolean;
};

function PluginSessionDashboardContent(props: PluginSessionDashboardProps) {
  const [expanded, setExpanded] = createSignal(false);
  const [activeTabId, setActiveTabId] = createSignal("");
  const [viewError, setViewError] = createSignal<string | null>(null);
  const [boardView, setBoardView] =
    createSignal<typeof import("../components/board/board-view.tsx").BoardView>();
  const [viewAttempt, setViewAttempt] = createSignal(0);
  const [expansionInitialized, setExpansionInitialized] = createSignal(false);
  const scope = createMemo(
    () =>
      props.client && props.session?.sessionKey.trim()
        ? { client: props.client, cacheKey: boardProviderCacheKey(props.session) }
        : null,
    {
      equals: (left, right) => left?.client === right?.client && left?.cacheKey === right?.cacheKey,
    },
  );
  const resource = createMemo(() => {
    const current = scope();
    if (!current) {
      return null;
    }
    const lease = untrack(() =>
      acquireBoardProviderForSession(
        props.session!,
        current.client,
        props.connected,
        false,
        false,
        props.canMutate,
        props.canGrant,
      ),
    );
    onCleanup(() => lease.release());
    const projection = projectBoardProvider(lease.provider);
    const callbacks: BoardViewCallbacks = {
      get appViewGeneration() {
        return projection.read().appViewGeneration;
      },
      applyOps: (ops) => lease.provider.applyOps(ops),
      grant: (name, decision) => lease.provider.grant(name, decision),
      selectTab: setActiveTabId,
      frameLoadFailed: (name) => lease.provider.refreshWidgetFrame(name),
      widgetAppView: (name, revision) => lease.provider.widgetAppView(name, revision),
      refreshWidgetAppView: (name, revision) => lease.provider.refreshWidgetAppView(name, revision),
    };
    return { lease, projection, callbacks };
  });
  createEffect(
    () => ({
      resource: resource(),
      connected: props.connected,
      canMutate: props.canMutate,
      canGrant: props.canGrant,
    }),
    (current) =>
      current.resource?.lease.update(props.client!, current.connected, {
        canPinWidgets: false,
        canPinMcpApps: false,
        canMutate: current.canMutate,
        canGrant: current.canGrant,
      }),
  );
  let reconciledProvider: ReturnType<typeof resource> = null;
  createEffect(
    () => {
      const current = resource();
      return { current, state: current?.projection.read() };
    },
    ({ current, state }) => {
      const replaced = current !== reconciledProvider;
      reconciledProvider = current;
      if (replaced) {
        setExpansionInitialized(false);
        setActiveTabId("");
      }
      if (!state) {
        return;
      }
      setActiveTabId((active) =>
        !replaced && state.snapshot.tabs.some((tab) => tab.tabId === active)
          ? active
          : (state.snapshot.tabs[0]?.tabId ?? ""),
      );
      if ((replaced || !expansionInitialized()) && state.hasLoadedSnapshot) {
        setExpansionInitialized(true);
        setExpanded(boardExists(state.snapshot));
      }
    },
  );
  createEffect(viewAttempt, () => {
    let current = true;
    setViewError(null);
    void import("../components/board/board-view.tsx")
      .then((module) => {
        if (current) {
          setBoardView(() => module.BoardView);
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setViewError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      current = false;
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
        aria-expanded={expanded() ? "true" : "false"}
        onClick={() => {
          setExpansionInitialized(true);
          setExpanded((value) => !value);
        }}
      >
        <span class="plugin-session-dashboard__title">
          <Icon name="kanban" />
          <span>{t("pluginUi.dashboardTitle")}</span>
        </span>
        <span class="plugin-session-dashboard__chevron" aria-hidden="true">
          <Icon name="arrowDown" />
        </span>
      </button>
      <div class="plugin-session-dashboard__body" hidden={!expanded()}>
        {viewError() ? (
          <>
            <p role="alert">{viewError()}</p>
            <button type="button" onClick={() => setViewAttempt((value) => value + 1)}>
              {t("common.retry")}
            </button>
          </>
        ) : (
          <Show
            when={board()}
            fallback={<p class="plugin-session-dashboard__empty">{t("pluginUi.dashboardEmpty")}</p>}
          >
            {(current) => (
              <Show when={boardView()} keyed>
                {(BoardView) => (
                  <BoardView
                    active={expanded() && props.presented}
                    session={current().session}
                    snapshot={current().snapshot}
                    activeTabId={activeTabId()}
                    widgetFrameUrl={(name: string, revision: number) =>
                      current().lease.provider.widgetFrameUrl(name, revision)
                    }
                    callbacks={current().callbacks}
                    canMutate={props.canMutate}
                    canGrant={props.canGrant}
                  />
                )}
              </Show>
            )}
          </Show>
        )}
      </div>
      <Show when={!expanded() && expansionInitialized() && !board()}>
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
