import { Show } from "solid-js";
import type { SessionVisibility } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerSessionPeopleEnglish } from "../../../i18n/locales/en-session-people.ts";
import "../../../styles/chat/sharing-mobile.css";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerSessionPeopleEnglish);

export type ChatSessionSharingOptionsProps = {
  visibility: SessionVisibility;
  publicShare: boolean;
  openDisabledReason?: string;
  onOpen: () => void;
};

// People owns placement and eligibility; its host owns the destination and focus.
export function ChatSessionSharingOptions(props: ChatSessionSharingOptionsProps) {
  const value = () =>
    props.publicShare
      ? t("chat.sessionSharing.publicIndicator")
      : t(
          `chat.sessionSharing.${props.visibility === "read-only" ? "readOnly" : props.visibility}`,
        );

  return (
    <button
      type="button"
      class="chat-sharing-options"
      disabled={Boolean(props.openDisabledReason)}
      aria-description={props.openDisabledReason}
      onClick={() => {
        if (!props.openDisabledReason) {
          props.onOpen();
        }
      }}
    >
      <Icon name="sharingOptions" class="chat-sharing-options__icon" />
      <span class="chat-sharing-options__label">{t("chat.sessionSharing.sharingOptions")}</span>
      <span class="chat-sharing-options__value">
        <Show when={props.publicShare}>
          <Icon name="globe" class="chat-sharing-options__public-icon" />
        </Show>
        <span>{value()}</span>
      </span>
      <Icon name="chevronRight" class="chat-sharing-options__chevron" />
    </button>
  );
}
