import { createErrorBoundary } from "@solidjs/signals";
import { createSignal, lazy, Loading, onSettled, Show } from "solid-js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { NearViewportObserver } from "../../components/near-viewport-observer.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

const BoardDocument = lazy(() => import("../../components/board/board-document.tsx"), {
  export: "OpenClawBoardDocument",
});

export type DashboardPreviewProps = {
  gatewaySnapshot?: ApplicationGatewaySnapshot;
  sessionKey?: string;
  agentId?: string;
};

export function DashboardPreview(props: DashboardPreviewProps) {
  let host!: HTMLElement;
  const [nearVisible, setNearVisible] = createSignal(false);
  onSettled(() => {
    let active = true;
    const visibility = new NearViewportObserver(200, () => {
      if (active) {
        setNearVisible(visibility.nearVisible);
      }
    });
    // Bounds before the first paint would activate every gallery preview at once.
    const frame = window.requestAnimationFrame(() => visibility.observe(host));
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      visibility.disconnect();
    };
  });
  return (
    <openclaw-dashboard-preview
      ref={(element) => {
        host = element;
      }}
    >
      <Show when={nearVisible()}>
        <>
          {createErrorBoundary(
            () => (
              <Loading>
                <BoardDocument
                  passive={true}
                  gatewaySnapshot={props.gatewaySnapshot}
                  preparedSession={{ sessionKey: props.sessionKey ?? "", agentId: props.agentId }}
                />
              </Loading>
            ),
            (error) => (
              <div class="dashboard-preview__error">
                {t("dashboardDocument.loadFailed", { error: formatUiError(error()) })}
              </div>
            ),
          )}
        </>
      </Show>
    </openclaw-dashboard-preview>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-dashboard-preview": HTMLAttributes<HTMLElement>;
    }
  }
}
