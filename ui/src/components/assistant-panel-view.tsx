import { Errored, For, lazy, Loading, onSettled, Show, type Accessor } from "solid-js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../app/stale-chunk-reload.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { JSX } from "../types/solid-elements.d.ts";
import type { AssistantPanelOwner } from "./assistant-panel-controller.ts";
import { AssistantPanelLoading } from "./assistant-panel-loading.tsx";
import { Icon } from "./solid/icon.tsx";
import { LazyViewError } from "./solid/lazy-view-error.tsx";
import { askBrandLabel } from "./theme-brand-label.ts";

// Reuse the resolved renderer across context-only remounts of the same host.
const Content = lazy(() => import("./assistant-panel-content.ts"), {
  export: "AssistantPanelContent",
});

export function AssistantPanelView(props: {
  state: Accessor<AssistantPanelOwner>;
  onContentLoaded: () => void;
}): JSX.Element {
  const state = () => props.state();
  const visible = () => state().available() && state().dockLayout.open;
  const dock = () => state().dockLayout.dock;
  const waitingForHome = () => state().destination() === "home" && !state().homeStarted();
  const contentActive = () => visible() && !waitingForHome();
  const session = () => {
    const destination = state().destination();
    return typeof destination === "string" ? undefined : destination.params;
  };
  const target = () => session() ?? state().homeTarget();
  const destinationKind = () => {
    const destination = state().destination();
    return typeof destination === "string" ? destination : "session";
  };
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
      <Show when={state().dockLayout.resizer}>
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
              state().destination() === "custodian" && state().props.store?.sending
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
                    aria-pressed={state().destination() === destination ? "true" : "false"}
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
          {state().destination() === "home" ? (
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
      <Show when={state().contentDefined() || state().shouldLoadContent()}>
        {(_shown) => {
          // The boundary reports rejection; success still notifies a dismissed view.
          void Content.preload().then(
            () => props.onContentLoaded(),
            () => {},
          );
          return (
            <Errored
              fallback={(error, reset) => {
                let active = true;
                const canRetry = () => active && state().shouldLoadContent();
                async function retry() {
                  if (!canRetry()) {
                    return;
                  }
                  if (
                    isStaleChunkImportError(error()) &&
                    (await retryStaleChunkReloadWhenReachable({ canReload: canRetry }))
                  ) {
                    return;
                  }
                  if (canRetry()) {
                    reset();
                  }
                }
                onSettled(() => {
                  const stale = isStaleChunkImportError(error());
                  return () => {
                    active = false;
                    if (stale) {
                      cancelStaleChunkRecovery();
                    }
                  };
                });
                return (
                  <LazyViewError
                    actionLabel={t("common.retry")}
                    error={error()}
                    stale={isStaleChunkImportError(error())}
                    subtitle={t("assistantPanel.title")}
                    onClose={() => state().setOpen(false)}
                    onRetry={() => {
                      void retry();
                    }}
                  />
                );
              }}
            >
              <Loading fallback={waitingForHome() ? undefined : <AssistantPanelLoading />}>
                <Content
                  hidden={!contentActive()}
                  active={contentActive()}
                  destination={destinationKind()}
                  sessionKey={target().sessionKey}
                  agentId={target().agentId}
                  sessionContext={session()?.context}
                  context={state().context()}
                  pageRouteId={state().props.pageRouteId}
                  pageSessionKey={state().props.pageSessionKey}
                  pageAgentId={state().props.pageAgentId}
                  store={state().props.store}
                  onStore={(store) => state().acceptStore(store)}
                />
              </Loading>
            </Errored>
          );
        }}
      </Show>
      <Show when={visible() && waitingForHome()}>
        <AssistantPanelLoading />
      </Show>
    </section>
  );
}
