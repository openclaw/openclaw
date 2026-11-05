import { createMemo, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatFailedMessageEditEnglish } from "../../../i18n/locales/en-chat-failed-message-edit.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createFailedMessageEdit, type FailedMessageEditSource } from "../failed-message-edit.ts";
import type { openChatRewindConfirmation } from "./chat-message-confirmation-view.tsx";

registerChatFailedMessageEditEnglish();

export default function ChatFailedMessageEditButton(props: {
  source?: FailedMessageEditSource;
  confirm: typeof openChatRewindConfirmation;
  onFocusComposer?: () => void;
}) {
  const edit = createMemo(() => createFailedMessageEdit(props.source));
  const label = () => t("chat.failedMessageEdit.label");
  return (
    <Show when={edit()}>
      <span class="chat-confirm-wrap">
        <openclaw-tooltip
          prop:content={edit()?.disabled ? t("chat.failedMessageEdit.draftBlocked") : label()}
        >
          <button
            type="button"
            class="btn btn--sm"
            aria-label={label()}
            disabled={edit()?.disabled}
            onClick={(event) => {
              const initialEdit = edit();
              const onFocusComposer = props.onFocusComposer;
              if (initialEdit) {
                props.confirm(event.currentTarget, () => {
                  void Promise.resolve(initialEdit.run()).then((edited) => {
                    if (edited) {
                      onFocusComposer?.();
                    }
                  });
                });
              }
            }}
          >
            <Icon name="refresh" />
            {label()}
          </button>
        </openclaw-tooltip>
      </span>
    </Show>
  );
}
