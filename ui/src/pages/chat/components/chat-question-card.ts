import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import {
  isOptionalElementDefined,
  LazyCustomElementRequestController,
} from "../../../app/lazy-custom-element.ts";
import type { QuestionDraft, QuestionPrompt } from "../../../app/question-prompt.ts";
import { renderLazyViewError } from "../../../components/lazy-view-error.ts";
import { renderLoadingState } from "../../../components/loading-state.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";

type QuestionPanelQuestion = QuestionPrompt["questions"][number];

type QuestionPanelViewModel = {
  requestKey: string;
  title: string;
  questions: QuestionPanelQuestion[];
  agentId?: string;
  sessionKey?: string;
  secretStoreAllowedHostsDraft?: string;
  collapsed: boolean;
  autoFocus?: boolean;
  nonBlocking?: boolean;
  collapsedLabel?: string;
  disabled: boolean;
  submitting?: boolean;
  drafts: Map<string, QuestionDraft>;
  error?: string | null;
  notice?: string;
  requestPosition?: { current: number; total: number };
};

export type QuestionPanelProps = {
  model: QuestionPanelViewModel;
  onSubmit?: (answersById: Record<string, string[]>) => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  onChange?: () => void;
  onSecretStoreAllowedHostsChange?: (allowedHosts: string) => void;
  onDismissError?: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  onPreviousRequest?: () => void;
  onNextRequest?: () => void;
};

export type QuestionPanelOptions = Pick<
  QuestionPanelProps,
  "onChange" | "onSubmit" | "onSkip" | "onCollapsedChange" | "onPreviousRequest" | "onNextRequest"
> & {
  collapsed?: boolean;
  requestPosition?: QuestionPanelViewModel["requestPosition"];
};

export function createGatewayQuestionPanelProps(
  prompt: QuestionPrompt,
  options: QuestionPanelOptions,
): QuestionPanelProps {
  const { onChange, onSubmit, onSkip } = options;
  return {
    model: {
      requestKey: prompt.id,
      title: t("chat.questions.eyebrow"),
      questions: prompt.questions,
      agentId: prompt.agentId,
      sessionKey: prompt.sessionKey,
      secretStoreAllowedHostsDraft: prompt.secretStoreAllowedHostsDraft,
      collapsed: options.collapsed ?? false,
      disabled: prompt.status !== "pending",
      submitting: prompt.submitting,
      drafts: prompt.drafts,
      error: prompt.error,
      requestPosition: options.requestPosition,
    },
    onChange,
    onSecretStoreAllowedHostsChange: (allowedHosts) => {
      prompt.secretStoreAllowedHostsDraft = allowedHosts;
      onChange?.();
    },
    onSubmit: onSubmit
      ? async (answersById) => {
          await onSubmit(answersById);
          if (prompt.status === "pending" && prompt.error) {
            throw new Error(prompt.error);
          }
        }
      : undefined,
    onSkip: onSkip
      ? async () => {
          await onSkip();
          if (prompt.status === "pending" && prompt.error) {
            throw new Error(prompt.error);
          }
        }
      : undefined,
    onDismissError:
      prompt.error && onChange
        ? () => {
            prompt.error = null;
            onChange();
          }
        : undefined,
    onCollapsedChange: options.onCollapsedChange,
    onPreviousRequest: options.onPreviousRequest,
    onNextRequest: options.onNextRequest,
  };
}

function terminalAnswer(prompt: QuestionPrompt, question: QuestionPanelQuestion): string {
  if (prompt.status === "cancelled") {
    return t("chat.questions.skipped");
  }
  if (prompt.status === "expired") {
    return t("chat.questions.expired");
  }
  if (prompt.status === "unavailable") {
    return t("chat.questions.unavailable");
  }
  if (question.isSecret) {
    return t("chat.questions.answered");
  }
  const answer = prompt.answers?.answers[question.questionId]?.join(", ");
  if (answer) {
    return answer;
  }
  if (prompt.answeredElsewhere) {
    return t("chat.questions.answeredElsewhere");
  }
  return t("chat.questions.answered");
}

export function renderChatQuestionSummary(prompt: QuestionPrompt) {
  if (prompt.status === "pending") {
    return nothing;
  }
  return html`
    <div class="chat-question-summary" aria-label=${t("chat.questions.summaryLabel")}>
      ${prompt.questions.map(
        (question) => html`
          <div class="chat-question-summary__item">
            <div class="chat-question-summary__prompt">${question.question}</div>
            <div class="chat-question-summary__line">
              <strong>${question.header}:</strong>
              <span>${terminalAnswer(prompt, question)}</span>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

// Summaries and panel props are needed during chat boot; interactive controls are not.
const questionPanelElement = {
  tagName: "openclaw-chat-question-panel",
  get label() {
    return t("chat.questions.eyebrow");
  },
  loadModule: () => import("./chat-question-panel.ts"),
};

export class ChatQuestionCard extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: QuestionPanelProps;
  private readonly panelLoader = new LazyCustomElementRequestController(this);

  override willUpdate(): void {
    this.panelLoader.requestWhileActive(
      questionPanelElement,
      this.isConnected && Boolean(this.props),
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.panelLoader.requestWhileActive(questionPanelElement, false);
    super.disconnectedCallback();
  }

  override render() {
    if (!this.props) {
      return nothing;
    }
    if (isOptionalElementDefined(questionPanelElement)) {
      return html`<openclaw-chat-question-panel
        .props=${this.props}
      ></openclaw-chat-question-panel>`;
    }
    const state = this.panelLoader.visibleState;
    return state?.status === "error"
      ? renderLazyViewError({
          error: state.error,
          stale: state.stale,
          subtitle: questionPanelElement.label,
          onRetry: () => this.panelLoader.retry(),
        })
      : renderLoadingState();
  }
}

if (!customElements.get("openclaw-chat-question-card")) {
  customElements.define("openclaw-chat-question-card", ChatQuestionCard);
}
