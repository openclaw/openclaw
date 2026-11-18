import { Show, type Element } from "solid-js";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { BoardSessionSurface, type BoardSessionSurfaceProps } from "./board-session-surface.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

export function ChatBoardPanel(props: {
  controls?: Element;
  error: string | undefined;
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
        onViewRef={props.surface.onViewRef}
        controls={props.controls}
        active={props.surface.active}
        session={props.surface.session}
        snapshot={props.surface.snapshot}
        activeTabId={props.surface.activeTabId}
        pageWidgetName={props.surface.pageWidgetName}
        canMutate={props.surface.canMutate}
        canGrant={props.surface.canGrant}
        callbacks={props.surface.callbacks}
        widgetFrameUrl={props.surface.widgetFrameUrl}
      />
    </Show>
  );
}
