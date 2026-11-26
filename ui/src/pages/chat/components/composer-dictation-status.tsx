import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { MicrophoneMeterStatus } from "../talk/microphone-meter.ts";
import { MicrophoneActivity } from "./chat-voice-activity.tsx";

// Dictation feedback starts on the click itself: pulsing bars while the microphone
// opens, then the live input level while listening. The permission hint only
// appears when opening takes long enough that a browser prompt is the likely cause.
const DICTATION_PERMISSION_HINT_DELAY_MS = 1_000;

function DictationStartingLabel() {
  const [slow, setSlow] = createSignal(false);
  onSettled(() => {
    const timer = globalThis.setTimeout(() => setSlow(true), DICTATION_PERMISSION_HINT_DELAY_MS);
    return () => globalThis.clearTimeout(timer);
  });
  return (
    <>
      {slow() ? t("chat.composer.microphoneAccessPending") : t("chat.composer.dictationStarting")}
    </>
  );
}

export function ActiveDictationStatus(props: {
  readDictation: () => ComposerDictationOwner | undefined;
}) {
  const phase = createMemo((): MicrophoneMeterStatus | null => {
    const dictation = props.readDictation();
    if (!dictation?.active && !dictation?.transcribing) {
      return null;
    }
    return dictation.connecting
      ? "connecting"
      : dictation.finalizing || !dictation.active
        ? "thinking"
        : "listening";
  });
  const recovery = () => !props.readDictation()?.active && props.readDictation()?.recovery;
  return (
    <Show when={phase() || recovery()}>
      <div
        class="agent-chat__dictation-status"
        data-transcribing={phase() === "thinking" ? "" : undefined}
        data-recovery={recovery() ? "" : undefined}
        role={phase() === "listening" ? undefined : "status"}
        aria-live={phase() === "listening" ? undefined : "polite"}
        aria-atomic={phase() === "listening" ? undefined : "true"}
      >
        <span
          class={[
            "agent-chat__dictation-phase",
            { "agent-chat__dictation-phase--listening text-shimmer": phase() === "listening" },
          ]}
          style={{ "--text-shimmer-duration": "4s" }}
        >
          {props.readDictation()?.recovery?.retrying ? (
            t("chat.dictation.retrying")
          ) : phase() === "connecting" ? (
            <DictationStartingLabel />
          ) : phase() === "thinking" ? (
            t("chat.composer.dictationFinalizing")
          ) : phase() === "listening" ? (
            t("chat.composer.dictationListening")
          ) : (
            t("chat.dictation.retained")
          )}
        </span>
        <Show when={phase()} keyed>
          {(current) => (
            <MicrophoneActivity
              status={current}
              inputLevel={current === "listening" ? props.readDictation()?.inputLevel : undefined}
            />
          )}
        </Show>
        <Show when={recovery()}>
          <button
            type="button"
            class="btn btn--sm"
            disabled={props.readDictation()?.recovery?.retrying}
            onClick={() => void props.readDictation()?.retry()}
          >
            {t("chat.dictation.retry")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            onClick={() => props.readDictation()?.discardRecovery()}
          >
            {t("chat.dictation.discard")}
          </button>
        </Show>
      </div>
    </Show>
  );
}
