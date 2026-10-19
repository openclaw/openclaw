import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { Show } from "solid-js";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import type { BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import type { PresentationValue } from "../../lib/presentation.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { usePanePresentation } from "./chat-pane-presentation.ts";

export type BoardSessionSurfaceProps = {
  onViewRef?: (element: HTMLElementTagNameMap["openclaw-board-view"]) => void | (() => void);
  active: PresentationValue;
  session: BoardGetParams;
  snapshot: BoardSnapshot | undefined;
  activeTabId: string;
  pageWidgetName?: string;
  canMutate: boolean;
  canGrant: boolean;
  callbacks: BoardViewCallbacks;
  widgetFrameUrl: BoardWidgetFrameUrl;
};

export function BoardSessionSurface(props: BoardSessionSurfaceProps & { elementReady?: boolean }) {
  const active = usePanePresentation(() => props.active);
  return (
    <div class="board-session-surface" hidden={!active()} inert={!active()}>
      <div class="board-session-surface__board">
        <openclaw-board-view
          ref={[elementRef(props.onViewRef)]}
          prop:active={active()}
          prop:session={props.session}
          prop:snapshot={props.snapshot}
          prop:activeTabId={props.activeTabId}
          prop:pageWidgetName={props.pageWidgetName ?? ""}
          prop:widgetFrameUrl={props.widgetFrameUrl}
          prop:callbacks={props.callbacks}
          prop:canMutate={props.canMutate}
          prop:canGrant={props.canGrant}
        />
        <Show when={!(props.elementReady ?? Boolean(customElements.get("openclaw-board-view")))}>
          <PanelLoadingSkeleton variant="board" label={t("common.loading")} overlay />
        </Show>
      </div>
    </div>
  );
}
