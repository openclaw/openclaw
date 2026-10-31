import { createErrorBoundary } from "@solidjs/signals";
import { createSignal, lazy, Loading, onSettled, Show } from "solid-js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { observeIntersection } from "../../lib/reactive/observers.ts";

const BoardDocument = lazy(() => import("../../components/board/board-document.tsx"), {
  export: "OpenClawBoardDocument",
});

export function DashboardPreview(props: {
  gatewaySnapshot?: ApplicationGatewaySnapshot;
  sessionKey?: string;
  agentId?: string;
}) {
  let host!: HTMLElement;
  const [nearVisible, setNearVisible] = createSignal(false);
  onSettled(() =>
    observeIntersection([host], (entries) => setNearVisible(entries.at(-1)!.isIntersecting), {
      rootMargin: "200px 0px",
    }),
  );
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
