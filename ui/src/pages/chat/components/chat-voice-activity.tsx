import { createMemo, Repeat, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { RealtimeTalkLevelSignal } from "../talk/level.ts";
import { MicrophoneMeterCanvas } from "../talk/microphone-meter-canvas.tsx";
import type { MicrophoneMeterStatus } from "../talk/microphone-meter.ts";
import type { RealtimeTalkStatus } from "../talk/session.ts";

registerEnglishCatalog(registerChatComposerEnglish);

export function voiceStatusLabel(
  status: RealtimeTalkStatus | undefined,
  detail: string | null | undefined,
) {
  return (
    detail?.trim() ||
    t(
      status === "thinking"
        ? "chat.voice.asking"
        : status === "connecting"
          ? "chat.voice.connecting"
          : "chat.voice.listening",
    )
  );
}

type MicrophoneActivityProps = {
  status?: RealtimeTalkStatus;
  inputLevel?: RealtimeTalkLevelSignal;
};

// Levels stay with the Talk owner; only status/source changes replace the canvas.
export function MicrophoneActivity(props: MicrophoneActivityProps) {
  const canvasLifetime = createMemo(
    (): { status: MicrophoneMeterStatus; source: RealtimeTalkLevelSignal | undefined } => ({
      status:
        props.status === "connecting" || props.status === "thinking" ? props.status : "listening",
      source: props.inputLevel,
    }),
    {
      equals: (previous, next) =>
        previous.status === next.status && previous.source === next.source,
    },
  );
  let host: HTMLElement | undefined;
  const bars: HTMLElement[] = [];
  return (
    <openclaw-microphone-activity
      ref={(element) => (host = element)}
      class="agent-chat__voice-activity"
      data-level="0"
      data-status={canvasLifetime().status}
      data-source="microphone"
      aria-hidden="true"
    >
      <Repeat count={7}>
        {(index) => (
          <span
            ref={(element) => (bars[index] = element)}
            class="agent-chat__voice-activity-bar"
            style={{ "--talk-bar-delay": `${index * -70}ms` }}
          />
        )}
      </Repeat>
      <Show when={canvasLifetime()} keyed>
        {(initial) => (
          <MicrophoneMeterCanvas
            initialStatus={initial.status}
            initialSource={initial.source}
            readHost={() => host}
            readBars={() => bars}
          />
        )}
      </Show>
    </openclaw-microphone-activity>
  );
}

type ChatVoiceStatusProps = {
  status?: RealtimeTalkStatus;
  detail?: string | null;
  onDismissError?: () => void;
  onUseSystemDefaultMicrophone?: () => Promise<void>;
};

export function ChatVoiceStatus(props: ChatVoiceStatusProps) {
  return (
    <Show
      when={props.status === "connecting"}
      fallback={
        <Show when={props.status === "error" && props.detail}>
          <div class="agent-chat__composer-errors agent-chat__composer-errors--standalone">
            <div class="agent-chat__composer-error agent-chat__talk-status" role="alert">
              <span class="agent-chat__composer-error-icon" aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <div class="callout__content">
                <div class="agent-chat__talk-status-text">{props.detail}</div>
                <Show when={props.onUseSystemDefaultMicrophone}>
                  <button
                    class="btn btn--sm"
                    type="button"
                    onClick={() => void props.onUseSystemDefaultMicrophone?.()}
                  >
                    {t("chat.composer.useSystemDefaultMicrophoneForCall")}
                  </button>
                </Show>
              </div>
              <Show when={props.onDismissError}>
                <button
                  class="callout__dismiss"
                  type="button"
                  onClick={() => props.onDismissError?.()}
                  aria-label={t("chat.composer.dismissVoiceInputError")}
                >
                  <Icon name="x" />
                </button>
              </Show>
            </div>
          </div>
        </Show>
      }
    >
      <div
        class="callout agent-chat__talk-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {voiceStatusLabel(props.status, props.detail)}
      </div>
    </Show>
  );
}

export function ComposerDictationStatus(props: {
  readDictation: () => ComposerDictationOwner | undefined;
}) {
  const content = createMemo(() => {
    const dictation = props.readDictation();
    if (!dictation?.active) {
      return null;
    }
    if (dictation.connecting) {
      return (
        <ChatVoiceStatus status="connecting" detail={t("chat.composer.microphoneAccessPending")} />
      );
    }
    return (
      <div class="agent-chat__composer-status-stack">
        <div
          class={[
            "agent-chat__dictation-status",
            { "agent-chat__dictation-status--finalizing": dictation.finalizing },
          ]}
        >
          <span
            class={[
              "agent-chat__dictation-phase",
              { "agent-chat__dictation-phase--listening": !dictation.finalizing },
            ]}
          >
            {dictation.finalizing
              ? t("chat.composer.dictationFinalizing")
              : t("chat.composer.dictationListening")}
          </span>
        </div>
      </div>
    );
  });
  return <>{content()}</>;
}
