import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { t } from "../../i18n/index.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/view-types.ts";

type ReadyAppView = Extract<BoardWidgetAppViewState, { status: "ready" }>;
type RetiringAppView = HTMLElement & {
  teardown?: () => Promise<void>;
  restartAfterTeardown?: () => void;
};

export function BoardMcpAppContent(props: {
  accessNotice: SolidJSX.Element;
  active: boolean;
  appView?: BoardWidgetAppViewState;
  busy: boolean;
  loading: boolean;
  nearVisible: boolean;
  sessionKey: string;
  widget: BoardWidget;
  expired: () => void;
  remove: () => void;
  retry: () => void;
  retired?: () => void;
}) {
  let element: RetiringAppView | undefined;
  let generation = 0;
  const [presented, setPresented] = createSignal<ReadyAppView | undefined>(undefined, {
    ownedWrite: true,
  });
  createEffect(
    () => {
      const view = props.appView;
      return view?.status === "ready" &&
        view.expiresAtMs > Date.now() &&
        (!props.active || props.nearVisible)
        ? view
        : undefined;
    },
    (next) => {
      const current = ++generation;
      if (next) {
        setPresented(next);
        element?.restartAfterTeardown?.();
        return;
      }
      const retirement = element?.teardown?.();
      if (retirement) {
        void retirement.then(() => {
          if (current === generation) {
            setPresented(undefined);
            untrack(() => props.retired?.());
          } else {
            element?.restartAfterTeardown?.();
          }
        });
      } else {
        setPresented(undefined);
        untrack(() => props.retired?.());
      }
    },
  );
  onCleanup(() => {
    generation += 1;
  });
  const Loading = () => (
    <div class="board-widget__app-loading" data-test-id="board-mcp-app-loading">
      {t("board.widget.appLoading")}
    </div>
  );
  return (
    <div class="board-widget__mcp-app">
      {props.accessNotice}
      <Show
        when={presented()}
        fallback={
          <Show
            when={props.nearVisible && props.appView?.status === "stale"}
            fallback={<Loading />}
          >
            <div class="board-widget__stale" data-test-id="board-mcp-app-stale">
              <strong>{t("board.widget.appStaleTitle")}</strong>
              <span>{t("board.widget.appStaleDetail")}</span>
              <div class="board-widget__grant-actions">
                <button
                  class="btn btn--small btn--primary"
                  type="button"
                  disabled={props.loading}
                  onClick={() => props.retry()}
                >
                  {t("board.widget.retry")}
                </button>
                <button
                  class="btn btn--small"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.remove()}
                >
                  {t("board.widget.remove")}
                </button>
              </div>
            </div>
          </Show>
        }
      >
        {(ready) => (
          <mcp-app-view
            ref={(node) => {
              element = node;
            }}
            class="board-widget__mcp-app-view"
            prop:sessionKey={props.sessionKey}
            prop:viewId={ready().viewId}
            prop:fillContainer={true}
            prop:surface="board"
            title={props.widget.title || props.widget.name}
            onOpenclaw-mcp-app-view-expired={() => props.expired()}
          />
        )}
      </Show>
    </div>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "mcp-app-view": HTMLAttributes<HTMLElementTagNameMap["mcp-app-view"]> &
        Properties<HTMLElementTagNameMap["mcp-app-view"]>;
    }
  }
}
