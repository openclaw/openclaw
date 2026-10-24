import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createSignal, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { registerBoardDocumentEnglish } from "../../i18n/locales/en-board-document.ts";
import { registerBoardEnglish } from "../../i18n/locales/en-board.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/view-types.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { LazyViewError } from "../solid/lazy-view-error.tsx";

registerEnglishCatalog(registerBoardDocumentEnglish);

registerEnglishCatalog(registerBoardEnglish);

type ReadyAppView = Extract<BoardWidgetAppViewState, { status: "ready" }>;
const McpAppView = lazy(() => import("../mcp-app-view.tsx"), { export: "McpAppView" });

function McpAppLoadError(props: { error: unknown; active: boolean; reset: () => void }) {
  let connected = true;
  onSettled(() => () => {
    connected = false;
  });
  const retry = async () => {
    const reloading =
      isStaleChunkImportError(props.error) &&
      (await retryStaleChunkReloadWhenReachable({ canReload: () => connected && props.active }));
    if (connected && props.active && !reloading) {
      props.reset();
    }
  };
  return (
    <LazyViewError
      error={props.error}
      stale={isStaleChunkImportError(props.error)}
      subtitle={t("board.widget.kindMcp")}
      onRetry={() => void retry()}
    />
  );
}

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
  viewRef: (element: HTMLElementTagNameMap["mcp-app-view"] | undefined) => void;
}) {
  let element: HTMLElementTagNameMap["mcp-app-view"] | undefined;
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
        element?.restartAfterTeardown();
        return;
      }
      const retirement = element?.teardown();
      if (retirement) {
        void retirement.then(() => {
          if (current === generation) {
            setPresented(undefined);
            props.retired?.();
          } else {
            element?.restartAfterTeardown();
          }
        });
      } else {
        setPresented(undefined);
        props.retired?.();
      }
    },
  );
  onSettled(() => {
    // Preserve preloading before the lease arrives; Errored owns a failed read when rendered.
    void McpAppView.preload().catch(() => undefined);
    return () => {
      generation += 1;
      props.viewRef(undefined);
    };
  });
  const McpAppLoading = () => (
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
            fallback={<McpAppLoading />}
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
          <Errored
            fallback={(error, reset) => (
              <McpAppLoadError error={error()} active={props.active} reset={reset} />
            )}
          >
            <Loading fallback={<McpAppLoading />}>
              <McpAppView
                ref={(node) => {
                  element = node;
                  props.viewRef(node);
                }}
                class="board-widget__mcp-app-view"
                sessionKey={props.sessionKey}
                viewId={ready().viewId}
                fillContainer={true}
                surface="board"
                title={props.widget.title || props.widget.name}
                onOpenclaw-mcp-app-view-expired={() => props.expired()}
              />
            </Loading>
          </Errored>
        )}
      </Show>
    </div>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "mcp-app-view": HTMLAttributes<HTMLElementTagNameMap["mcp-app-view"]> &
        Properties<HTMLElementTagNameMap["mcp-app-view"]> & {
          "prop:onHeightChange"?: HTMLElementTagNameMap["mcp-app-view"]["onHeightChange"];
        };
    }
  }
}
