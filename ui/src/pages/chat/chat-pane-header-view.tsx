import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import "./chat-pane-header-presence.css";

type PresenceProps = Pick<
  HTMLElementTagNameMap["openclaw-viewer-facepile"],
  "staticUsers" | "personActivity"
>;

export function PaneSubagentStop(props: { onAbort: () => void; notice?: boolean }) {
  return (
    <button
      class={
        props.notice ? "btn btn--sm agent-chat__disabled-banner-stop" : "chat-subagent-detail__stop"
      }
      type="button"
      aria-label={t("chat.runControls.stopGenerating")}
      onClick={() => props.onAbort()}
    >
      <Icon name="stop" />
      <span>{t("chat.runControls.stop")}</span>
    </button>
  );
}
export function PaneHeaderPresence(props: PresenceProps) {
  return (
    <openclaw-viewer-facepile
      class="chat-pane__presence chat-pane__presence--desktop"
      prop:staticUsers={props.staticUsers}
      prop:maxVisible={3}
      prop:personActivity={props.personActivity}
      variant="session"
    />
  );
}
