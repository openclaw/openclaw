import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html } from "lit";
import type { BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import { livePresentation, type PresentationValue } from "../../lit/presentation-binding.ts";

type BoardSessionSurfaceProps = {
  active: PresentationValue;
  session: BoardGetParams;
  snapshot: BoardSnapshot;
  activeTabId: string;
  pageWidgetName?: string;
  canMutate: boolean;
  canGrant: boolean;
  callbacks: BoardViewCallbacks;
  widgetFrameUrl: BoardWidgetFrameUrl;
};

let boardViewLoad: Promise<unknown> | null = null;

export async function ensureBoardViewElement(): Promise<boolean> {
  if (customElements.get("openclaw-board-view")) {
    return false;
  }
  boardViewLoad ??= import("../../components/board/board-view.ts");
  await boardViewLoad;
  return true;
}

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
      </div>
    </div>
  `;
}
