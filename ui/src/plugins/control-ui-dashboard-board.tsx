import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { Show } from "solid-js";
import { BoardView } from "../components/board/board-view.tsx";
import type { acquireBoardProviderForSession, BoardViewCallbacks } from "../lib/board/provider.ts";
import type { BoardSnapshot } from "../lib/board/types.ts";
import { t } from "../lib/reactive/i18n.ts";

export function PluginSessionDashboardBoard(props: {
  board: {
    session: BoardGetParams;
    snapshot: BoardSnapshot;
    lease: ReturnType<typeof acquireBoardProviderForSession>;
    callbacks: BoardViewCallbacks;
  } | null;
  active: boolean;
  activeTabId: string;
  canMutate: boolean;
  canGrant: boolean;
}) {
  return (
    <Show
      when={props.board}
      fallback={<p class="plugin-session-dashboard__empty">{t("pluginUi.dashboardEmpty")}</p>}
    >
      {(current) => (
        <BoardView
          active={props.active}
          session={current().session}
          snapshot={current().snapshot}
          activeTabId={props.activeTabId}
          widgetFrameUrl={(name: string, revision: number) =>
            current().lease.provider.widgetFrameUrl(name, revision)
          }
          callbacks={current().callbacks}
          canMutate={props.canMutate}
          canGrant={props.canGrant}
        />
      )}
    </Show>
  );
}
