import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { createSignal, onSettled, Show } from "solid-js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { NearViewportObserver } from "../../components/near-viewport-observer.ts";
import { t } from "../../lib/reactive/i18n.ts";

export type DashboardPreviewProps = {
  gatewaySnapshot?: ApplicationGatewaySnapshot;
  sessionKey?: string;
  agentId?: string;
  error?: string | null;
};

export function DashboardPreviewContent(props: DashboardPreviewProps, host: HTMLElement) {
  const [nearVisible, setNearVisible] = createSignal(false);
  onSettled(() => {
    const visibility = new NearViewportObserver(200, () => setNearVisible(visibility.nearVisible));
    // Bounds before the first paint would activate every gallery preview at once.
    const frame = window.requestAnimationFrame(() => visibility.observe(host));
    return () => {
      window.cancelAnimationFrame(frame);
      visibility.disconnect();
    };
  });
  return (
    <Show when={nearVisible()}>
      <Show
        when={!props.error}
        fallback={
          <div class="dashboard-preview__error">
            {t("dashboardDocument.loadFailed", { error: props.error ?? "" })}
          </div>
        }
      >
        <openclaw-board-document
          prop:passive={true}
          prop:gatewaySnapshot={props.gatewaySnapshot}
          prop:preparedSession={{ sessionKey: props.sessionKey ?? "", agentId: props.agentId }}
        />
      </Show>
    </Show>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-board-document": JSX.HTMLAttributes<HTMLElement> & {
        "prop:passive"?: boolean;
        "prop:gatewaySnapshot"?: ApplicationGatewaySnapshot;
        "prop:preparedSession"?: BoardGetParams;
      };
    }
  }
}
