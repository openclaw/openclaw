import { For } from "solid-js";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import "../../../styles/chat/conversation-notices.css";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

function Lines(props: { widths: number[] }) {
  return (
    <div class="chat-conversation-loading__lines">
      <For each={props.widths}>
        {(width) => <span class="skeleton" style={{ width: `${width}%` }} />}
      </For>
    </div>
  );
}

export function ChatConversationLoading(props: { route: boolean }) {
  return (
    <div
      class={["chat-conversation-loading", { "chat-conversation-loading--delayed": !props.route }]}
      role="status"
      aria-busy="true"
      aria-label={t("chat.thread.loading")}
    >
      <div aria-hidden="true">
        <Lines widths={[82, 53]} />
      </div>
      <div class="chat-conversation-loading__user" aria-hidden="true">
        <Lines widths={[94, 81, 54]} />
      </div>
      <div class="chat-conversation-loading__assistant" aria-hidden="true">
        <Lines widths={[51]} />
        <div class="chat-conversation-loading__list">
          <For each={[78, 63, 84]}>
            {(width) => (
              <div>
                <i />
                <Lines widths={[width]} />
              </div>
            )}
          </For>
        </div>
        <Lines widths={[87, 58]} />
      </div>
    </div>
  );
}
