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
    if (!dictation?.active) {
      return null;
    }
    return dictation.connecting ? "connecting" : dictation.finalizing ? "thinking" : "listening";
  });
  return (
    <Show when={phase()} keyed>
      {(current) => (
        <div class="agent-chat__composer-status-stack">
          <div
            class={[
              "agent-chat__dictation-status",
              { "agent-chat__dictation-status--finalizing": current === "thinking" },
            ]}
            role={current === "connecting" ? "status" : undefined}
            aria-live={current === "connecting" ? "polite" : undefined}
          >
            <MicrophoneActivity
              status={current}
              inputLevel={current === "listening" ? props.readDictation()?.inputLevel : undefined}
            />
            <span
              class={[
                "agent-chat__dictation-phase",
                { "agent-chat__dictation-phase--listening text-shimmer": current === "listening" },
              ]}
            >
              {current === "connecting" ? (
                <DictationStartingLabel />
              ) : current === "thinking" ? (
                t("chat.composer.dictationFinalizing")
              ) : (
                t("chat.composer.dictationListening")
              )}
            </span>
          </div>
        </div>
      )}
    </Show>
  );
}
