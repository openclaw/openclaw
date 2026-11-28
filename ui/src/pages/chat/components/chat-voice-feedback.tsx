import { Show } from "solid-js";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { isRealtimeTalkMicrophoneIssueMessage } from "../talk/input.ts";
export function ChatVoiceProblem(props: {
  detail?: string | null;
  tone?: "danger" | "warning";
  onDismissError?: () => void;
  onUseSystemDefaultMicrophone?: () => Promise<void>;
}) {
  return (
    <InlineAlert
      tone={
        props.tone ??
        (props.detail && isRealtimeTalkMicrophoneIssueMessage(props.detail) ? "warning" : "danger")
      }
      class="agent-chat__composer-alert"
      onDismiss={props.onDismissError}
      dismissLabel={t("chat.composer.dismissVoiceInputError")}
      action={
        <Show when={props.onUseSystemDefaultMicrophone}>
          <button
            class="btn btn--sm"
            type="button"
            onClick={() => void props.onUseSystemDefaultMicrophone?.()}
          >
            {t("chat.composer.useSystemDefaultMicrophoneForCall")}
          </button>
        </Show>
      }
    >
      {props.detail}
    </InlineAlert>
  );
}
