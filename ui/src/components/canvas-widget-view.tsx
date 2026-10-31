import { Show, createEffect, createMemo, onCleanup } from "solid-js";
import { registerBoardEnglish } from "../i18n/locales/en-board.ts";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { projectCallbackOwner } from "../lib/reactive/callback-owner.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { createCanvasWidget, type CanvasWidgetViewProps } from "./canvas-widget-view-owner.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

registerEnglishCatalog(registerBoardEnglish);

type CanvasWidgetViewContent = {
  readonly documentHtml: string | undefined;
  readonly previewFrame: HTMLIFrameElement | undefined;
};
export type OpenClawCanvasWidgetView = SolidBridgeElement<
  CanvasWidgetViewProps,
  CanvasWidgetViewContent
>;

export const CanvasWidgetView = defineSolidBridge<CanvasWidgetViewProps, CanvasWidgetViewContent>(
  "openclaw-canvas-widget-view",
  (props, host) => {
    host.style.display = "contents";
    host.style.minHeight = "";
    const context = useApplication();
    const gateway = projectGateway(context.gateway);
    const { owner: widget, view: projection } = projectCallbackOwner(
      (notify) => {
        const owner = createCanvasWidget(host, host, context, notify);
        onCleanup(owner.clearView);
        return owner;
      },
      (owner) => owner.state,
    );
    const scriptProperty = Object.getOwnPropertyDescriptor(host, "allowScripts")!;
    // Even a false→true change within one commit must revoke the old private port.
    Object.defineProperty(host, "allowScripts", {
      ...scriptProperty,
      set(value: boolean) {
        if (value !== host.allowScripts) {
          widget.retireScriptPolicy();
        }
        scriptProperty.set!.call(host, value);
        widget.notify();
      },
    });
    const read = projection.read;
    // Admit authenticated reads and retire stale sandbox authority when external identity changes.
    createEffect(
      () => [
        props.docId,
        props.sessionKey,
        props.connectionGeneration,
        props.allowScripts,
        props.presentationActive,
        gateway.read(),
      ],
      () => {
        widget.reconcile();
        widget.notify();
      },
    );
    createEffect(
      () => [projection.revision(), props.presentationActive],
      () => widget.syncSandbox(),
    );
    onCleanup(() => {
      Object.defineProperty(host, "allowScripts", scriptProperty);
    });
    const retry = () => {
      widget.clearView();
      widget.reconcile();
      widget.notify();
    };
    const source = createMemo(() => {
      const view = read().view;
      if (!view || !context) {
        return undefined;
      }
      try {
        return {
          src: props.allowScripts
            ? resolveSandboxHostUrl(
                view.sandboxUrl,
                view.sandboxPort,
                view.sandboxOrigin,
                context.gateway.connection.gatewayUrl,
                window.location.origin,
              )
            : undefined,
        };
      } catch (error) {
        return { error: formatUiError(error) };
      }
    });
    const height = () => read().contentHeight ?? props.preferredHeight ?? 420;
    return (
      <Show
        when={!read().error}
        fallback={
          <div class="board-widget__error" role="alert">
            {read().error}
            <Show when={!read().accessDenied}>
              <button class="btn btn--small" onClick={retry}>
                {t("common.retry")}
              </button>
            </Show>
          </div>
        }
      >
        <Show
          when={Boolean(source())}
          fallback={
            <Show
              when={read().pending}
              fallback={
                // Preserve the empty reserved box across the lazy element's upgrade.
                <div
                  role="status"
                  aria-label={t("common.loading")}
                  style={{ "min-height": `${height()}px` }}
                />
              }
            >
              <div
                class="board-widget__notice"
                role="status"
                style={{ "min-height": `${height()}px` }}
              >
                {t(
                  read().awaitingResult
                    ? "board.widget.waitingForResult"
                    : "board.widget.waitingForConnection",
                )}
              </div>
            </Show>
          }
        >
          <Show when={!source()?.error} fallback={<div role="alert">{source()?.error}</div>}>
            <Show when={read().pending}>
              <div class="board-widget__notice" role="status">
                {t(
                  read().awaitingResult
                    ? "board.widget.waitingForResult"
                    : "board.widget.waitingForConnection",
                )}
              </div>
            </Show>
            <Show when={read().resourceError}>
              <div class="board-widget__notice" role="status">
                {t("board.widget.resourceUnavailable")}
                <button class="btn btn--small" onClick={retry}>
                  {t("common.retry")}
                </button>
              </div>
            </Show>
            <Show when={read().runtimeError}>
              <div class="board-widget__notice" role="status">
                {t("board.widget.runtimeError", { message: read().runtimeError })}
              </div>
            </Show>
            <Show when={String(read().sandboxGeneration)} keyed>
              {(_generation) => (
                <iframe
                  class="chat-tool-card__preview-frame"
                  allow="fullscreen"
                  title={props.title}
                  src={source()?.src}
                  srcdoc={props.allowScripts ? undefined : read().view?.html}
                  sandbox={props.allowScripts ? "allow-scripts allow-same-origin allow-forms" : ""}
                  referrerpolicy="origin"
                  style={{
                    height: height() ? `${height()}px` : undefined,
                    "min-height": height() ? `${height()}px` : undefined,
                  }}
                  ref={widget.setFrame}
                  onError={() => widget.syncFrameError()}
                />
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    );
  },
  {
    properties: {
      docId: { default: "" },
      sessionKey: { default: "" },
      messageTimestamp: { default: undefined, type: Number },
      title: { default: "" },
      preferredHeight: { default: undefined, type: Number },
      onHeightChange: { default: undefined, attribute: false },
      connectionGeneration: { default: 0 },
      presentationActive: { default: true },
      allowScripts: { default: true },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-canvas-widget-view": OpenClawCanvasWidgetView;
  }
}
