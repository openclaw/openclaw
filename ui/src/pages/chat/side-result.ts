// Control UI chat module implements side result behavior.
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import "../../components/tooltip.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { detectTextDirection } from "../../lib/text-direction.ts";

export type ChatSideResult = {
  kind: "btw";
  runId: string;
  sessionKey: string;
  agentId?: string;
  question: string;
  text: string;
  isError: boolean;
  ts: number;
};

export function parseChatSideResult(payload: unknown): ChatSideResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind !== "btw") {
    return null;
  }
  const runId = normalizeOptionalString(candidate.runId);
  const sessionKey = normalizeOptionalString(candidate.sessionKey);
  const question = normalizeOptionalString(candidate.question);
  const text = normalizeOptionalString(candidate.text);
  if (!(runId && sessionKey && question && text)) {
    return null;
  }
  return {
    kind: "btw",
    runId,
    sessionKey,
    ...(normalizeOptionalString(candidate.agentId)
      ? { agentId: normalizeOptionalString(candidate.agentId) }
      : {}),
    question,
    text,
    isError: candidate.isError === true,
    ts:
      typeof candidate.ts === "number" && Number.isFinite(candidate.ts) ? candidate.ts : Date.now(),
  };
}

export function renderSideResult(
  sideResult: ChatSideResult | null | undefined,
  onDismiss?: () => void,
): TemplateResult | typeof nothing {
  if (!sideResult) {
    return nothing;
  }
  return html`
    <section
      class=${`chat-side-result ${sideResult.isError ? "chat-side-result--error" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="BTW side result"
    >
      <div class="chat-side-result__header">
        <div class="chat-side-result__label-row">
          <span class="chat-side-result__label">BTW</span>
          <span class="chat-side-result__meta">Not saved to chat history</span>
        </div>
        <openclaw-tooltip content="Dismiss">
          <button
            class="btn chat-side-result__dismiss"
            type="button"
            aria-label="Dismiss BTW result"
            @click=${() => onDismiss?.()}
          >
            ${icons.x}
          </button>
        </openclaw-tooltip>
      </div>
      <div class="chat-side-result__question">${sideResult.question}</div>
      <div class="chat-side-result__body" dir=${detectTextDirection(sideResult.text)}>
        ${unsafeHTML(toSanitizedMarkdownHtml(sideResult.text))}
      </div>
    </section>
  `;
}
