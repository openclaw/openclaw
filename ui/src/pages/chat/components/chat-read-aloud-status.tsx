import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, Show } from "solid-js";
import { GatewayRequestError } from "../../../api/gateway-connect-errors.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { useApplication, useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { navigateToModelProvider } from "../../model-providers/navigation.ts";
import { navigateToSpeechSettings } from "../voice-api-key-navigation.ts";
import { voiceApiKeyMessage, VoiceApiKeyNotice } from "../voice-api-key-notice.tsx";

/** A recording the selected provider can't transcribe because its sign-in doesn't cover voice. */
export function RecordingApiKeyNotice(props: { provider: string; agentId?: string }) {
  const app = useOptionalApplication();
  return (
    <VoiceApiKeyNotice
      kind="recording"
      provider={props.provider}
      onConfigure={
        app
          ? (provider) => navigateToModelProvider(app, props.agentId ?? null, provider)
          : undefined
      }
    />
  );
}

export default function ReadAloudStatus(props: { error: unknown; sessionKey?: string }) {
  const app = useApplication();
  const keyProvider = createMemo(async () => {
    const error = props.error;
    const provider =
      error instanceof GatewayRequestError
        ? asOptionalRecord(error.details)?.unconfiguredSpeechProvider
        : undefined;
    const sessionKey = props.sessionKey;
    if (typeof provider !== "string" || !sessionKey) {
      return undefined;
    }
    const catalog = await app.gateway.snapshot.client
      ?.request<TalkCatalogResult>("talk.catalog", { sessionKey })
      .catch(() => undefined);
    return catalog?.speech.providers.some((entry) => entry.id === provider && entry.apiKeyRequired)
      ? provider
      : undefined;
  });
  return (
    <Show when={keyProvider()} fallback={<span role="status">{formatUiError(props.error)}</span>}>
      {(provider) => (
        <span class="chat-send-status" role="status" style={{ order: 0 }}>
          <span>{voiceApiKeyMessage("speech", provider())}</span>
          <button
            class="chat-send-status__action"
            style={{ color: "var(--muted)", "text-decoration": "underline" }}
            type="button"
            onClick={() => navigateToSpeechSettings(app)}
          >
            {t("chat.composer.configureCapability")}
          </button>
        </span>
      )}
    </Show>
  );
}
