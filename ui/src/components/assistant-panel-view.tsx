import { Show, For, type Accessor } from "solid-js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { CustodianSessionStore } from "../pages/custodian/custodian-session-store.ts";
import type { AssistantPanelController } from "./assistant-panel-controller.ts";
import { AssistantPanelLoading } from "./assistant-panel-loading.ts";
import { Icon } from "./solid/icon.tsx";
import { LazyElementStateView } from "./solid/lazy-view-error.tsx";
import { askBrandLabel } from "./theme-brand-label.ts";

export function AssistantPanelView(props: {
  controller: AssistantPanelController;
  revision: Accessor<number>;
}) {
  const state = () => {
    props.revision();
    return props.controller;
  };
  const resizer = () => state().dockLayout.resizerProps;
  const visible = () => state().available && state().dockLayout.open;
  const dock = () => state().dockLayout.dock;
  const session = () => {
    const destination = state().destination;
    return typeof destination === "string" ? undefined : destination.params;
  };
  const target = () => session() ?? state().homeTarget;
  const destinationKind = () => {
    const destination = state().destination;
    return typeof destination === "string" ? destination : "session";
  };
  const contentDefined = () => state().contentDefined;
  const contentState = () => state().contentLoader.visibleState;
  const style = () =>
    dock() === "bottom"
      ? `height:${state().dockLayout.height}px`
      : `width:${state().dockLayout.width}px`;
  return (
    <section
      class={["assistant-panel", `assistant-panel--${dock()}`]}
      style={style()}
      hidden={!visible()}
      aria-label={t("assistantPanel.title")}
      onPointerDown={() => state().claimInput("dock")}
      onFocusIn={() => state().claimInput("dock")}
    >
      <Show when={resizer()}>
        {(geometry) => (
          <resizable-divider
            class={["assistant-panel-resizer", `assistant-panel-resizer--${dock()}`]}
            prop:orientation={geometry().orientation}
            prop:label={t("assistantPanel.resize")}
            prop:splitRatio={geometry().splitRatio}
            prop:minRatio={geometry().minRatio}
            prop:maxRatio={geometry().maxRatio}
            prop:measureRatio={geometry().measureRatio}
            prop:measureSize={geometry().measureSize}
            onResize={(event: CustomEvent<{ splitRatio: number }>) =>
              state().dockLayout.resize(event)
            }
            onResize-end={() => state().dockLayout.persist()}
          />
        )}
      </Show>
      <header class="rail-header assistant-panel-header" onMouseDown={beginNativeWindowDrag}>
        <div class="assistant-panel-title">
          <openclaw-mascot
            mood={
              state().destination === "custodian" && state().props.store?.sending
                ? "thinking"
                : "idle"
            }
            prop:size={16}
          />
          {session() ? (
            <button
              type="button"
              class="assistant-panel-tab rail-header__title"
              aria-pressed="true"
              title={session()?.label}
            >
              {session()?.label}
            </button>
          ) : undefined}
          <For each={["home", "custodian"] as const}>
            {(destination) => (
              <>
                {" "}
                {state().availableFor(destination) ? (
                  <button
                    type="button"
                    class="assistant-panel-tab"
                    aria-pressed={state().destination === destination ? "true" : "false"}
                    onClick={() => state().openDestination(destination)}
                  >
                    {destination === "home" ? t("assistantPanel.home") : askBrandLabel(t)}
                  </button>
                ) : undefined}{" "}
              </>
            )}
          </For>
        </div>
        <div class="rail-header__actions assistant-panel-actions">
          {state().destination === "home" ? (
            <button
              class="rail-header__action assistant-panel-icon"
              type="button"
              aria-label={t("assistantPanel.openHome")}
              onClick={() => state().openHomePage()}
            >
              <Icon name="maximize" />
            </button>
          ) : undefined}
          <button
            class="rail-header__action assistant-panel-icon"
            type="button"
            aria-label={
              dock() === "bottom" ? t("assistantPanel.dockRight") : t("assistantPanel.dockBottom")
            }
            onClick={() => state().dockLayout.setDock(dock() === "bottom" ? "right" : "bottom")}
          >
            {dock() === "bottom" ? <Icon name="panelRightOpen" /> : <Icon name="panelBottomOpen" />}
          </button>
          <button
            class="rail-header__action assistant-panel-icon"
            type="button"
            aria-label={t("assistantPanel.close")}
            onClick={() => state().setOpen(false)}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      {contentDefined() ? (
        <openclaw-assistant-panel-content
          hidden={!visible() || (state().destination === "home" && !state().homeStarted)}
          prop:active={visible() && (state().destination !== "home" || state().homeStarted)}
          prop:destination={destinationKind()}
          prop:sessionKey={target().sessionKey}
          prop:agentId={target().agentId}
          prop:sessionContext={session()?.context}
          prop:context={state().context}
          prop:pageRouteId={state().props.pageRouteId}
          prop:pageSessionKey={state().props.pageSessionKey}
          prop:pageAgentId={state().props.pageAgentId}
          prop:store={state().props.store}
          onAssistant-custodian-store={(event: CustomEvent<CustodianSessionStore>) => {
            state().acceptStore(event.detail);
          }}
        />
      ) : undefined}
      {visible() &&
      (!contentDefined() || (state().destination === "home" && !state().homeStarted)) ? (
        contentState()?.status === "error" ? (
          <LazyElementStateView
            state={contentState()!}
            onRetry={() => state().contentLoader.retry()}
            onClose={() => state().setOpen(false)}
          />
        ) : (
          <AssistantPanelLoading />
        )
      ) : undefined}
    </section>
  );
}
