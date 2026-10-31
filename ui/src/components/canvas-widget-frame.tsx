import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { Show } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { CanvasWidgetViewState } from "./canvas-widget-view-owner.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

/** Presentation only; the widget owner retains document and sandbox authority. */
export function CanvasWidgetFrame(props: {
  state: CanvasWidgetViewState;
  source?: { src?: string; srcdoc?: string; error?: string };
  height: number;
  title: string;
  allowScripts: boolean;
  input: boolean;
  onRetry: () => void;
  onFrame: (frame: HTMLIFrameElement) => void;
  onFrameError: () => void;
}) {
  return (
    <Show
      when={!props.state.error}
      fallback={
        <div class="board-widget__error" role="alert">
          {props.state.error}
          <Show when={!props.state.accessDenied}>
            <button class="btn btn--small" onClick={() => props.onRetry()}>
              {t("common.retry")}
            </button>
          </Show>
        </div>
      }
    >
      <Show
        when={Boolean(props.source)}
        fallback={
          <Show
            when={props.state.pending}
            fallback={
              // Preserve the empty reserved box across the lazy element's upgrade.
              <div
                role="status"
                aria-label={t("common.loading")}
                style={{ "min-height": `${props.height}px` }}
              />
            }
          >
            <div
              class="board-widget__notice"
              role="status"
              style={{ "min-height": `${props.height}px` }}
            >
              {t(
                props.state.awaitingResult
                  ? "board.widget.waitingForResult"
                  : "board.widget.waitingForConnection",
              )}
            </div>
          </Show>
        }
      >
        <Show when={!props.source?.error} fallback={<div role="alert">{props.source?.error}</div>}>
          <Show when={props.state.pending}>
            <div class="board-widget__notice" role="status">
              {t(
                props.state.awaitingResult
                  ? "board.widget.waitingForResult"
                  : "board.widget.waitingForConnection",
              )}
            </div>
          </Show>
          <Show when={props.state.resourceError}>
            <div class="board-widget__notice" role="status">
              {t("board.widget.resourceUnavailable")}
              <button class="btn btn--small" onClick={() => props.onRetry()}>
                {t("common.retry")}
              </button>
            </div>
          </Show>
          <Show when={props.state.runtimeError}>
            <div class="board-widget__notice" role="status">
              {t("board.widget.runtimeError", { message: props.state.runtimeError })}
            </div>
          </Show>
          <Show when={String(props.state.sandboxGeneration)} keyed>
            {(_generation) => (
              <iframe
                class="chat-tool-card__preview-frame"
                allow="fullscreen"
                title={props.title}
                src={props.source?.src}
                srcdoc={
                  props.source?.srcdoc ?? (props.allowScripts ? undefined : props.state.view?.html)
                }
                sandbox={
                  props.input
                    ? "allow-scripts"
                    : props.allowScripts
                      ? "allow-scripts allow-same-origin allow-forms"
                      : ""
                }
                tabindex={props.input ? -1 : undefined}
                referrerpolicy="origin"
                style={{
                  height: props.input || props.height ? `${props.height}px` : undefined,
                  "min-height": props.input || props.height ? `${props.height}px` : undefined,
                  "pointer-events": props.input ? "none" : undefined,
                  transition: "height var(--widget-height-duration, 0ms) var(--ease-out)",
                }}
                ref={props.onFrame}
                onError={() => props.onFrameError()}
              />
            )}
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

export function resolveCanvasWidgetFrameSource(
  view: CanvasDocumentViewResult | undefined,
  inputShell: string | undefined,
  allowScripts: boolean,
  gatewayUrl: string,
): { src?: string; srcdoc?: string; error?: string } | undefined {
  if (inputShell) {
    return { srcdoc: inputShell };
  }
  if (!view) {
    return undefined;
  }
  try {
    return {
      src: allowScripts
        ? resolveSandboxHostUrl(
            view.sandboxUrl,
            view.sandboxPort,
            view.sandboxOrigin,
            gatewayUrl,
            window.location.origin,
          )
        : undefined,
    };
  } catch (error) {
    return { error: formatUiError(error) };
  }
}
