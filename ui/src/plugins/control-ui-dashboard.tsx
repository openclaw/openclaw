import type { BoardGetParams } from "@openclaw/gateway-protocol";
import {
  Errored,
  Loading,
  Show,
  children,
  createMemo,
  createStore,
  isPending,
  lazy,
  onCleanup,
} from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { Icon } from "../components/solid/icon.tsx";
import { registerPluginManagementEnglish } from "../i18n/locales/en-plugin-management.ts";
import {
  acquireBoardProviderForSession,
  boardExists,
  boardProviderCacheKey,
  type BoardViewCallbacks,
} from "../lib/board/provider.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { observeSolidBridgeProperties } from "./control-ui-properties.ts";
import "./control-ui-dashboard.css";

registerEnglishCatalog(registerPluginManagementEnglish);

const DashboardBoard = lazy(() => import("./control-ui-dashboard-board.tsx"), {
  export: "PluginSessionDashboardBoard",
});

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
      selectTab: (activeTabId) =>
        setPresentation((draft) => {
          draft.activeTabId = activeTabId;
        }),
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
  const [presentation, setPresentation] = createStore<{
    scope: ReturnType<typeof scope>;
    expanded: boolean;
    initialized: boolean;
    activeTabId: string;
  }>(
    (draft) => {
      const current = scope();
      const state = resource()?.projection.read();
      const retained = draft.scope === current;
      const initialize = state?.hasLoadedSnapshot === true && (!retained || !draft.initialized);
      draft.expanded = initialize ? boardExists(state.snapshot) : draft.expanded;
      draft.initialized = initialize || (retained && draft.initialized);
      draft.activeTabId =
        retained && state?.snapshot.tabs.some((tab) => tab.tabId === draft.activeTabId)
          ? draft.activeTabId
          : (state?.snapshot.tabs[0]?.tabId ?? "");
      draft.scope = current;
    },
    { scope: null, expanded: false, initialized: false, activeTabId: "" },
    // Scope is an immutable identity, not nested presentation state.
    { shallow: true },
  );
  const board = createMemo(() => {
    const current = resource();
    const session = props.session;
    const state = current?.projection.read();
    return current && session && state && boardExists(state.snapshot)
      ? { ...current, session, snapshot: state.snapshot }
      : null;
  });
  const content = children(() => (
    <DashboardBoard
      board={board()}
      active={presentation.expanded && props.presented}
      activeTabId={presentation.activeTabId}
      canMutate={props.connected && props.canMutate}
      canGrant={props.connected && props.canGrant}
    />
  ));
  return (
    <section class="plugin-session-dashboard">
      <button
        type="button"
        class="plugin-session-dashboard__toggle"
        aria-expanded={presentation.expanded ? "true" : "false"}
        onClick={() =>
          setPresentation((draft) => {
            draft.initialized = true;
            draft.expanded = !draft.expanded;
          })
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
      <div class="plugin-session-dashboard__body" hidden={!presentation.expanded}>
        <Errored
          fallback={(error, reset) => {
            const message = () => {
              const failure = error();
              return failure instanceof Error ? failure.message : String(failure);
            };
            return (
              <Show when={!isPending(() => content())}>
                <p role="alert">{message()}</p>
                <button type="button" onClick={reset}>
                  {t("common.retry")}
                </button>
              </Show>
            );
          }}
        >
          <Loading>{content()}</Loading>
        </Errored>
      </div>
      <Show when={!presentation.expanded && presentation.initialized && !board()}>
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
