import { Show } from "solid-js";
import "../../components/modal-dialog.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { BoardSessionSurface, type BoardSessionSurfaceProps } from "./board-session-surface.tsx";

export function ChatBoardPanel(props: {
  error: string | undefined;
  elementReady: boolean;
  surface: BoardSessionSurfaceProps;
}) {
  return (
    <Show
      when={!props.error}
      fallback={
        <div class="board-session-surface__state board-session-surface__state--error" role="alert">
          {t("dashboardDocument.loadFailed", { error: props.error ?? "" })}
        </div>
      }
    >
      <BoardSessionSurface
        active={props.surface.active}
        session={props.surface.session}
        snapshot={props.surface.snapshot}
        activeTabId={props.surface.activeTabId}
        pageWidgetName={props.surface.pageWidgetName}
        canMutate={props.surface.canMutate}
        canGrant={props.surface.canGrant}
        callbacks={props.surface.callbacks}
        widgetFrameUrl={props.surface.widgetFrameUrl}
        elementReady={props.elementReady}
      />
    </Show>
  );
}

export function ChatBoardResetConfirmation(props: { onResolve: (confirmed: boolean) => void }) {
  return (
    <openclaw-modal-dialog
      label={t("chat.board.resetTitle")}
      description={t("chat.board.resetDescription")}
      onModal-cancel={() => props.onResolve(false)}
    >
      <div class="exec-approval-card board-reset-confirmation">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">{t("chat.board.resetTitle")}</div>
            <div class="exec-approval-sub">{t("chat.board.resetDescription")}</div>
          </div>
        </div>
        <openclaw-modal-actions class="exec-approval-actions">
          <button class="btn primary" type="button" onClick={() => props.onResolve(true)}>
            {t("common.confirm")}
          </button>
          <button class="btn" type="button" autofocus onClick={() => props.onResolve(false)}>
            {t("common.cancel")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
