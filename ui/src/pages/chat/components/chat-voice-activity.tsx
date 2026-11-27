import { type ComponentProps, Errored, lazy, Loading, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { RealtimeTalkStatus } from "../talk/session.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

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

const ActiveMicrophoneActivity = lazy(() => import("./microphone-activity.tsx"), {
  export: "MicrophoneActivity",
});

/** Meter failures must not interrupt the microphone Stop button. */
export function MicrophoneActivity(props: ComponentProps<typeof ActiveMicrophoneActivity>) {
  return (
    <Errored fallback={() => null}>
      <Loading fallback={<span class="agent-chat__voice-activity" aria-hidden="true" />}>
        <ActiveMicrophoneActivity {...props} />
      </Loading>
    </Errored>
  );
}

const ChatVoiceProblem = lazy(() => import("./chat-voice-feedback.tsx"), {
  export: "ChatVoiceProblem",
});

export function ChatVoiceStatus(
  props: ComponentProps<typeof ChatVoiceProblem> & { status?: RealtimeTalkStatus },
) {
  return (
    <Show
      when={props.status === "connecting"}
      fallback={
        <Show when={props.status === "error" && props.detail}>
          <ChatLazyBoundary
            fallback={
              <div class="callout agent-chat__talk-status" role="status">
                {props.detail}
              </div>
            }
          >
            <ChatVoiceProblem {...props} />
          </ChatLazyBoundary>
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

const DictationFormattingReview = lazy(() => import("./composer-dictation-formatting.tsx"), {
  export: "DictationFormattingReview",
});

/** Review gets the full composer width; capture status stays in the compact toolbar. */
export function ComposerDictationReview(props: {
  readDictation: () => ComposerDictationOwner | undefined;
}) {
  return (
    <Show when={props.readDictation()?.formattingReview}>
      <ChatLazyBoundary>
        <DictationFormattingReview readDictation={props.readDictation} />
      </ChatLazyBoundary>
    </Show>
  );
}
