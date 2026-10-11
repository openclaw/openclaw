import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { renderPanelLoadingSkeleton } from "../../components/panel-loading-skeleton.ts";
import { t } from "../../i18n/index.ts";
import type { BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import { livePresentation, type PresentationValue } from "../../lit/presentation-binding.ts";

type BoardSessionSurfaceProps = {
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

export const BOARD_VIEW_ELEMENT = {
  tagName: "openclaw-board-view",
  get label() {
    return t("chat.sidePanel.dashboard");
  },
  loadModule: () => import("../../components/board/board-view.ts"),
};

export function renderBoardSessionSurface(props: BoardSessionSurfaceProps) {
  return html`
    <div
      class="board-session-surface"
      ?hidden=${livePresentation(props.active, true)}
      ?inert=${livePresentation(props.active, true)}
    >
      <div class="board-session-surface__board">
        <openclaw-board-view
          .active=${livePresentation(props.active)}
          .session=${props.session}
          .snapshot=${props.snapshot}
          .activeTabId=${props.activeTabId}
          .pageWidgetName=${props.pageWidgetName ?? ""}
          .widgetFrameUrl=${props.widgetFrameUrl}
          .callbacks=${props.callbacks}
          .canMutate=${props.canMutate}
          .canGrant=${props.canGrant}
        ></openclaw-board-view>
        ${
          customElements.get("openclaw-board-view")
            ? nothing
            : renderPanelLoadingSkeleton("board", t("common.loading"), false, true)
        }
      </div>
    </div>
  `;
}
