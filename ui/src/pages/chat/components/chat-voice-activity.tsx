import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import { isRealtimeTalkMicrophoneIssueMessage } from "../talk/input.ts";
import type { RealtimeTalkLevelSignal } from "../talk/level.ts";
import type { MicrophoneMeterStatus } from "../talk/microphone-meter.ts";
import type { RealtimeTalkStatus } from "../talk/session.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

registerEnglishCatalog(registerChatComposerEnglish);

const MicrophoneMeterCanvas = lazy(() => import("./chat-microphone-meter-canvas.tsx"), {
  export: "MicrophoneMeterCanvas",
});

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

// Levels stay with the Talk owner; only status/source changes replace the canvas.
export function MicrophoneActivity(props: {
  status?: RealtimeTalkStatus;
  inputLevel?: RealtimeTalkLevelSignal;
}) {
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
  return (
    <openclaw-microphone-activity
      ref={(element) => (host = element)}
      class="agent-chat__voice-activity"
      data-level="0"
      data-status={canvasLifetime().status}
      data-source="microphone"
      aria-hidden="true"
    >
      <Show when={canvasLifetime()} keyed>
        {(initial) => {
          const initialStatus = initial.status;
          if (initialStatus === "connecting") {
            return null;
          }
          // The CSS dots remain available while the decorative canvas loads or fails.
          return (
            <Errored fallback={() => null}>
              <Loading>
                <MicrophoneMeterCanvas
                  host={() => host}
                  source={initial.source}
                  status={initialStatus}
                />
              </Loading>
            </Errored>
          );
        }}
      </Show>
    </openclaw-microphone-activity>
  );
}

export function ChatVoiceStatus(props: {
  status?: RealtimeTalkStatus;
  detail?: string | null;
  /** Defaults to warning for microphone access problems and danger otherwise. */
  tone?: "danger" | "warning";
  onDismissError?: () => void;
  onUseSystemDefaultMicrophone?: () => Promise<void>;
}) {
  return (
    <Show
      when={props.status === "connecting"}
      fallback={
        <Show when={props.status === "error" && props.detail}>
          <InlineAlert
            tone={
              props.tone ??
              (props.detail && isRealtimeTalkMicrophoneIssueMessage(props.detail)
                ? "warning"
                : "danger")
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

// The dictation phase view loads with the first dictation, outside the boot bundle.
const ActiveDictationStatus = lazy(() => import("./composer-dictation-status.tsx"), {
  export: "ActiveDictationStatus",
});

export function ComposerDictationStatus(props: {
  readDictation: () => ComposerDictationOwner | undefined;
}) {
  return (
    <Show when={props.readDictation()?.active || props.readDictation()?.transcribing}>
      <ChatLazyBoundary>
        <ActiveDictationStatus readDictation={props.readDictation} />
      </ChatLazyBoundary>
    </Show>
  );
}
