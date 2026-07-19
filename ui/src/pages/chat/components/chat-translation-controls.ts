import { html, nothing } from "lit";
import type { RealtimeTranslationTranscript } from "../realtime-translation.ts";
import type {
  RealtimeTranslationDirection,
  RealtimeTranslationInputSource,
  RealtimeTranslationStatus,
} from "../realtime-translation.ts";

export type RealtimeTranslationControlsProps = {
  active: boolean;
  status: RealtimeTranslationStatus;
  detail: string | null;
  direction: RealtimeTranslationDirection;
  inputSource: RealtimeTranslationInputSource;
  transcripts: RealtimeTranslationTranscript[];
  onDirectionChange: (direction: RealtimeTranslationDirection) => void;
  onInputSourceChange: (source: RealtimeTranslationInputSource) => void;
  onToggle: () => void;
};

export function renderRealtimeTranslationControls(props: RealtimeTranslationControlsProps) {
  const status =
    props.detail ??
    (props.status === "connecting"
      ? "Connecting live translation..."
      : props.status === "translating"
        ? "Translating while the speaker continues..."
        : props.status === "error"
          ? "Live translation stopped"
          : "Use headphones to prevent translated audio from feeding back into the input.");
  return html`
    <div class="chat-settings-popover__section" data-live-translation>
      <span class="chat-settings-popover__label">Live translation</span>
      <div class="agent-chat__talk-options agent-chat__talk-options--settings">
        <div class="agent-chat__talk-options-primary">
          <label class="agent-chat__talk-field">
            <span>Direction</span>
            <select
              .value=${props.direction}
              ?disabled=${props.active}
              @change=${(event: Event) =>
                props.onDirectionChange(
                  (event.currentTarget as HTMLSelectElement).value as RealtimeTranslationDirection,
                )}
            >
              <option value="zh-en">Chinese → English</option>
              <option value="en-zh">English → Chinese</option>
            </select>
          </label>
          <label class="agent-chat__talk-field">
            <span>Input</span>
            <select
              .value=${props.inputSource}
              ?disabled=${props.active}
              @change=${(event: Event) =>
                props.onInputSourceChange(
                  (event.currentTarget as HTMLSelectElement)
                    .value as RealtimeTranslationInputSource,
                )}
            >
              <option value="microphone">Microphone</option>
              <option value="shared-audio">Tab / meeting audio</option>
            </select>
          </label>
          <button type="button" class="btn btn--sm" @click=${props.onToggle}>
            ${props.active ? "Stop interpretation" : "Start interpretation"}
          </button>
        </div>
        <div
          class=${`agent-chat__talk-input-message ${props.status === "error" ? "agent-chat__talk-input-message--error" : ""}`}
          role=${props.status === "error" ? "alert" : "status"}
        >
          ${status}
        </div>
        ${props.transcripts.length > 0
          ? html`
              <div
                class="agent-chat__voice-turns"
                role="log"
                aria-label="Live translation transcript"
              >
                ${props.transcripts.slice(-8).map(
                  (entry) => html`
                    <div class="agent-chat__voice-turn agent-chat__voice-turn--${entry.role}">
                      <span class="agent-chat__voice-turn-speaker"
                        >${entry.role === "user" ? "Source" : "Translation"}</span
                      >
                      <span class="agent-chat__voice-turn-text">${entry.text}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}
