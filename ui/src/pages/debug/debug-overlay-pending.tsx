import { onSettled, Show } from "solid-js";
import { LazyViewError, type LazyElementState } from "../../components/solid/lazy-view-error.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { DebugOverlayFrame } from "./debug-overlay-frame-view.tsx";
import { DebugOverlayLoading } from "./debug-overlay-loading-view.tsx";
import type { DebugOverlayMode } from "./debug-overlay-state.ts";

export interface DebugOverlayFrameHost {
  readonly elements: { pendingDebugOverlayFrame?: HTMLElement };
  readonly lazyCustomElements: {
    retry(): void;
    close(): void;
  };
  readonly pendingDebugOverlayMode: DebugOverlayMode;
  togglePendingDebugOverlayMode(): void;
}

export function renderPendingDebugOverlay(props: {
  host: DebugOverlayFrameHost;
  state: LazyElementState;
  mode: DebugOverlayMode;
}) {
  let frame!: HTMLElement;
  onSettled(() => {
    const elements = props.host.elements;
    elements.pendingDebugOverlayFrame = frame;
    return () => {
      elements.pendingDebugOverlayFrame = undefined;
    };
  });
  const error = () => (props.state.status === "error" ? props.state : undefined);
  return (
    <DebugOverlayFrame
      ref={(element) => (frame = element)}
      mode={props.mode}
      onToggleMode={() => props.host.togglePendingDebugOverlayMode()}
      onClose={() => props.host.lazyCustomElements.close()}
      body={
        <Show
          when={error()}
          fallback={
            <Show when={props.mode === "minimized"} fallback={<DebugOverlayLoading />}>
              <div class="debug-overlay__compact-loading" role="status">
                {t("common.loading")}
              </div>
            </Show>
          }
        >
          {(state) => (
            <LazyViewError
              actionLabel={t("common.retry")}
              error={state().error}
              stale={state().stale}
              subtitle={state().element.label}
              onRetry={() => props.host.lazyCustomElements.retry()}
            />
          )}
        </Show>
      }
    />
  );
}
