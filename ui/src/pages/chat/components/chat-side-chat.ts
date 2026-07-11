// Floating side-chat panel: multi-turn /btw Q&A overlay pinned to the thread column.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import {
  buildSideChatFollowUpCommand,
  extractSideQuestionDisplayText,
} from "../../../lib/chat/side-question.ts";
import type { ChatSideResult, ChatSideResultPending } from "../../../lib/chat/side-result.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";

export type SideChatPanelProps = {
  turns: ChatSideResult[];
  pending: ChatSideResultPending | null;
  hidden: boolean;
  /** Archived/non-composable sessions render the transcript without the follow-up input. */
  canFollowUp: boolean;
  /** `question` is the user's typed follow-up for the pending-turn display;
   * `command` embeds prior-turn context and is never parsed back apart. */
  onFollowUp?: (command: string, question: string) => void;
  onClose?: () => void;
  onClear?: () => void;
};

export function isSideChatPanelVisible(
  props: Pick<SideChatPanelProps, "turns" | "pending" | "hidden">,
): boolean {
  return !props.hidden && (props.turns.length > 0 || props.pending != null);
}

function renderSideChatTurn(turn: ChatSideResult): TemplateResult {
  const question = extractSideQuestionDisplayText(turn.question);
  return html`
    <article class=${`chat-side-chat__turn ${turn.isError ? "chat-side-chat__turn--error" : ""}`}>
      <div class="chat-side-chat__question" dir=${detectTextDirection(question)}>${question}</div>
      <div class="chat-side-chat__answer" dir=${detectTextDirection(turn.text)}>
        ${unsafeHTML(toSanitizedMarkdownHtml(turn.text))}
      </div>
    </article>
  `;
}

function renderSideChatPendingTurn(pending: ChatSideResultPending): TemplateResult {
  const question = extractSideQuestionDisplayText(pending.question);
  return html`
    <article class="chat-side-chat__turn chat-side-chat__turn--pending">
      <div class="chat-side-chat__question" dir=${detectTextDirection(question)}>${question}</div>
      <div class="chat-side-chat__thinking">Thinking…</div>
    </article>
  `;
}

export function renderSideChatPanel(props: SideChatPanelProps): TemplateResult | typeof nothing {
  if (!isSideChatPanelVisible(props)) {
    return nothing;
  }
  const { turns, pending } = props;
  // Error turns carry failure text, not an answer; the newest real turn is
  // the context a follow-up rides on.
  const lastTurn = turns.findLast((turn) => !turn.isError) ?? null;
  // New turns (or a new pending question) pin the scroll position to the
  // bottom; the key guard keeps unrelated re-renders from fighting the user's
  // manual scroll.
  const scrollKey = `${turns.length}:${pending?.runId ?? pending?.ts ?? ""}`;
  const syncScroll = (element: Element | undefined) => {
    if (!(element instanceof HTMLElement) || element.dataset.sideChatScrollKey === scrollKey) {
      return;
    }
    element.dataset.sideChatScrollKey = scrollKey;
    element.scrollTop = element.scrollHeight;
  };
  const submitFollowUp = (input: HTMLInputElement) => {
    const followUp = buildSideChatFollowUpCommand(
      lastTurn
        ? { question: extractSideQuestionDisplayText(lastTurn.question), answer: lastTurn.text }
        : null,
      input.value,
    );
    if (!followUp || !props.onFollowUp) {
      return;
    }
    props.onFollowUp(followUp.command, followUp.question);
    input.value = "";
  };
  return html`
    <section class="chat-side-chat" role="dialog" aria-label="Side chat">
      <header class="chat-side-chat__header">
        <div class="chat-side-chat__heading">
          <h2 class="chat-side-chat__title">Side chat</h2>
          <span class="chat-side-chat__meta">Not saved to chat history</span>
        </div>
        <div class="chat-side-chat__actions">
          <openclaw-tooltip content="Clear side chat">
            <button
              class="btn btn--ghost btn--icon chat-icon-btn"
              type="button"
              aria-label="Clear side chat"
              @click=${() => props.onClear?.()}
            >
              ${icons.trash}
            </button>
          </openclaw-tooltip>
          <openclaw-tooltip content="Close side chat">
            <button
              class="btn btn--ghost btn--icon chat-icon-btn"
              type="button"
              aria-label="Close side chat"
              @click=${() => props.onClose?.()}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        </div>
      </header>
      <div class="chat-side-chat__scroll" aria-live="polite" ${ref(syncScroll)}>
        ${turns.map(renderSideChatTurn)} ${pending ? renderSideChatPendingTurn(pending) : nothing}
      </div>
      ${props.canFollowUp
        ? html`
            <footer class="chat-side-chat__composer">
              <div class="chat-side-chat__prompt">
                <input
                  class="chat-side-chat__input"
                  type="text"
                  placeholder="Follow up…"
                  aria-label="Follow up in side chat"
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key !== "Enter" || event.isComposing) {
                      return;
                    }
                    event.preventDefault();
                    submitFollowUp(event.currentTarget as HTMLInputElement);
                  }}
                />
                <button
                  class="btn btn--ghost btn--icon chat-icon-btn chat-side-chat__send"
                  type="button"
                  aria-label="Send follow-up"
                  @click=${(event: MouseEvent) => {
                    const input = (event.currentTarget as HTMLElement)
                      .closest(".chat-side-chat__prompt")
                      ?.querySelector<HTMLInputElement>(".chat-side-chat__input");
                    if (input) {
                      submitFollowUp(input);
                      input.focus();
                    }
                  }}
                >
                  ${icons.cornerDownLeft}
                </button>
              </div>
            </footer>
          `
        : nothing}
    </section>
  `;
}
