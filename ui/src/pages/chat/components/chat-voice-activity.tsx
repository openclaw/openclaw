import { createMemo, For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { RealtimeTalkLevelSignal } from "../talk/level.ts";
import type { RealtimeTalkStatus } from "../talk/session.ts";

const BAR_GAINS = [0.38, 0.62, 0.84, 1, 0.84, 0.62, 0.38];

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

// Levels stay with the talk owner; its subscription updates only decorative bars.
export function MicrophoneActivity(props: MicrophoneActivityProps) {
  const inputLevel = createMemo(() => {
    const source = props.inputLevel;
    return source && projectOwner(source, (owner) => owner.value, Object.is);
  });
  const level = () => inputLevel()?.read() ?? 0;
  return (
    <openclaw-microphone-activity
      class="agent-chat__voice-activity"
      data-level={String(level())}
      data-status={
        props.status === "connecting" || props.status === "thinking" ? props.status : "listening"
      }
      data-source="microphone"
      aria-hidden="true"
    >
      <For each={BAR_GAINS}>
        {(gain, index) => (
          <span
            class="agent-chat__voice-activity-bar"
            style={{
              "--talk-bar-delay": `${index() * -70}ms`,
              "--talk-bar-scale": String(0.18 + level() * gain * 0.82),
            }}
          />
        )}
      </For>
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
