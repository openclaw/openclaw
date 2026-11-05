import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createSignal, Errored, Loading, onSettled, Show } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { registerBoardDocumentEnglish } from "../../i18n/locales/en-board-document.ts";
import { registerBoardEnglish } from "../../i18n/locales/en-board.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/view-types.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { McpAppView } from "../mcp-app-view-lazy.ts";
import type { BoardAppDisplayAccess } from "../mcp-app-view-types.ts";
import { LazyViewError } from "../solid/lazy-view-error.tsx";

registerEnglishCatalog(registerBoardDocumentEnglish);

registerEnglishCatalog(registerBoardEnglish);

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
  appDisplay?: BoardAppDisplayAccess;
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
  const [presented, setPresented] = createSignal(false, {
    ownedWrite: true,
  });
  createEffect(
    () => {
      const view = props.appView;
      return (
        props.widget.contentKind === "mcp-app" &&
        (!props.active || props.nearVisible) &&
        ((view?.status === "ready" && view.expiresAtMs > Date.now()) ||
          (Boolean((props.active || presented()) && props.appDisplay) &&
            view?.status !== "stale" &&
            props.widget.grantState !== "pending" &&
            props.widget.grantState !== "rejected"))
      );
    },
    (next) => {
      const current = ++generation;
      if (next) {
        setPresented(true);
        element?.restartAfterTeardown();
        return;
      }
      const retirement = element?.teardown();
      if (retirement) {
        void retirement.then(() => {
          if (current === generation) {
            setPresented(false);
            props.retired?.();
          } else {
            element?.restartAfterTeardown();
          }
        });
      } else {
        setPresented(false);
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
        {() => (
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
                widget={props.widget}
                appDisplay={props.appDisplay}
                viewId={props.appView?.status === "ready" ? props.appView.viewId : ""}
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
