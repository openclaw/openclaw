import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { registerChatVoiceApiKeyEnglish } from "../../i18n/locales/en-chat-voice-api-key.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatVoiceApiKeyEnglish);

export type VoiceApiKeyNoticeProps = {
  kind: "talk" | "dictation" | "voice" | "speech" | "recording";
  provider: string;
  onConfigure?: (provider: string) => void;
  onDismiss?: () => void;
  class?: string;
};

export function voiceApiKeyMessage(kind: VoiceApiKeyNoticeProps["kind"], provider: string): string {
  const apiKey =
    provider === "openai"
      ? t("chat.voiceApiKey.openaiKey")
      : t("chat.voiceApiKey.providerKey", { provider: providerDisplayLabel(provider) });
  return t(`chat.voiceApiKey.${kind}`, { apiKey });
}

export function VoiceApiKeyNotice(props: VoiceApiKeyNoticeProps) {
  return (
    <InlineAlert
      tone="warning"
      class={props.class}
      onDismiss={props.onDismiss}
      action={
        props.onConfigure ? (
          <button
            type="button"
            class="btn btn--sm"
            onClick={() => props.onConfigure?.(props.provider)}
          >
            {t("chat.composer.configureCapability")}
          </button>
        ) : undefined
      }
    >
      {voiceApiKeyMessage(props.kind, props.provider)}
    </InlineAlert>
  );
}
