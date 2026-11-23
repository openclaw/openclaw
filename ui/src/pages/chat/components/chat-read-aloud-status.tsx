import { Show } from "solid-js";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { voiceApiKeyDetail, voiceApiKeyTitle } from "../voice-api-key-notice.tsx";
import { useVoiceApiKey } from "../voice-api-key.tsx";

export default function ReadAloudStatus(props: { error: unknown }) {
  const voiceApiKey = useVoiceApiKey();
  return (
    <Show
      when={voiceApiKey.provider("speech")}
      fallback={<span role="status">{formatUiError(props.error)}</span>}
    >
      {(provider) => (
        <span
          class="chat-send-status"
          role="status"
          style={{ "flex-basis": "100%", color: "var(--muted)" }}
        >
          <span>
            {voiceApiKeyTitle("speech", provider())}. {voiceApiKeyDetail()}
          </span>
          <button
            class="chat-send-status__action chat-send-status__retry"
            type="button"
            onClick={() => voiceApiKey.configure(provider())}
          >
            {t("chat.composer.configureCapability")}
          </button>
        </span>
      )}
    </Show>
  );
}
