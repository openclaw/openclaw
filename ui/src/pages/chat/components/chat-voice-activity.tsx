import { createMemo, onSettled, Repeat, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createMediaQuerySource } from "../../../lib/reactive/platform.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { RealtimeTalkLevelSignal } from "../talk/level.ts";
import { createMicrophoneMeter, type MicrophoneMeterStatus } from "../talk/microphone-meter.ts";
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
        {(initial) => {
          const initialStatus = initial.status;
          if (initialStatus === "connecting") {
            return null;
          }
          const initialSource = initial.source;
          const reducedMotion = createMediaQuerySource("(prefers-reduced-motion: reduce)");
          let canvas: HTMLCanvasElement | undefined;
          onSettled(() => {
            const currentHost = host;
            const surface = canvas;
            if (!currentHost || !surface) {
              return undefined;
            }
            let renderer: ReturnType<typeof createMicrophoneMeter> | undefined;
            const initialLevel = initialSource?.value ?? 0;
            const setLevel = (level: number) => {
              const value = String(level);
              if (currentHost.dataset.level !== value) {
                currentHost.dataset.level = value;
              }
              // CSS already draws silence. Allocate only when there is activity to paint.
              if (
                !renderer &&
                (initialStatus === "thinking" || (initialStatus === "listening" && level > 0))
              ) {
                renderer = createMicrophoneMeter(
                  currentHost,
                  surface,
                  bars,
                  initialStatus,
                  reducedMotion,
                );
                // Preserve the first transition from silence rather than jumping to its target.
                renderer.setLevel(initialLevel);
              }
              renderer?.setLevel(level);
            };
            // The owner's subscription immediately supplies its current level.
            const stop = initialSource?.subscribe(setLevel);
            if (!initialSource) {
              setLevel(0);
            }
            return () => {
              stop?.();
              renderer?.dispose();
            };
          });
          return (
            <canvas
              ref={(element) => (canvas = element)}
              class="agent-chat__voice-activity-canvas"
              aria-hidden="true"
            />
          );
        }}
      </Show>
    </openclaw-microphone-activity>
  );
}

export function ChatVoiceStatus(props: {
  status?: RealtimeTalkStatus;
  detail?: string | null;
  onDismissError?: () => void;
  onUseSystemDefaultMicrophone?: () => Promise<void>;
}) {
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
              { "agent-chat__dictation-phase--listening text-shimmer": !dictation.finalizing },
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
