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

export function voiceApiKeyTitle(kind: VoiceApiKeyNoticeProps["kind"], provider: string): string {
  return t(`chat.voiceApiKey.${kind}`, { provider: providerDisplayLabel(provider) });
}

export function voiceApiKeyDetail(): string {
  return t("chat.voiceApiKey.detail");
}

export function VoiceApiKeyNotice(props: VoiceApiKeyNoticeProps) {
  return (
    <InlineAlert
      tone="warning"
      class={props.class}
      title={voiceApiKeyTitle(props.kind, props.provider)}
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
      {voiceApiKeyDetail()}
    </InlineAlert>
  );
}
