import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { createMemo, lazy, type Element } from "solid-js";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import type { BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import type { PresentationValue } from "../../lib/presentation.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";

const BoardView = lazy(() => import("../../components/board/board-view.tsx"), {
  export: "BoardView",
});

export type BoardSessionSurfaceProps = {
  onViewRef?: (element: HTMLElementTagNameMap["openclaw-board-view"]) => void | (() => void);
  controls?: Element;
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

export function BoardSessionSurface(props: BoardSessionSurfaceProps) {
  const active = usePanePresentation(() => props.active);
  const session = createMemo(() => props.session, {
    equals: (previous, next) =>
      previous.sessionKey === next.sessionKey && previous.agentId === next.agentId,
  });
  const boardRef = elementRef((element: HTMLElementTagNameMap["openclaw-board-view"]) =>
    props.onViewRef?.(element),
  );
  return (
    <div class="board-session-surface" hidden={!active()} inert={!active()}>
      {props.controls}
      <div class="board-session-surface__board">
        <ChatLazyBoundary
          fallback={<PanelLoadingSkeleton variant="board" label={t("common.loading")} overlay />}
        >
          <BoardView
            ref={[boardRef]}
            active={active()}
            session={session()}
            snapshot={props.snapshot}
            activeTabId={props.activeTabId}
            pageWidgetName={props.pageWidgetName ?? ""}
            widgetFrameUrl={props.widgetFrameUrl}
            callbacks={props.callbacks}
            canMutate={props.canMutate}
            canGrant={props.canGrant}
          />
        </ChatLazyBoundary>
      </div>
    </div>
  );
}
