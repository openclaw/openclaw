import { For } from "solid-js";
import { registerChatWelcomeEnglish } from "../../../i18n/locales/en-chat-welcome.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { GUEST_QUICK_START_ACTIONS } from "./chat-welcome.ts";

registerChatWelcomeEnglish();

export function GuestQuickStart(props: {
  onDraftChange: (next: string) => void;
  onFocusComposer?: () => void;
}) {
  return (
    <div class="agent-chat__guest-start">
      <p class="agent-chat__guest-start-copy">{t("chat.welcome.quickStart.hint")}</p>
      <For each={GUEST_QUICK_START_ACTIONS}>
        {(action, index) => (
          <button
            type="button"
            class={["agent-chat__suggestion", { "agent-chat__guest-start-primary": index() === 0 }]}
            onClick={() => {
              props.onDraftChange(t(`chat.welcome.quickStart.${action}.prompt`));
              props.onFocusComposer?.();
            }}
          >
            {t(`chat.welcome.quickStart.${action}.label`)}
          </button>
        )}
      </For>
    </div>
  );
}
