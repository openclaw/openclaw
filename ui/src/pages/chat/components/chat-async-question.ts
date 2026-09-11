import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import "./chat-question-card.ts";

type AsyncQuestions = {
  itemId: string;
  questions: { title: string; options?: string[] }[];
};

export type AsyncQuestionDraft = {
  answers: Record<string, string[]>;
  status?: "submitting" | "submitted" | "skipped";
  error?: string;
};

export type AsyncQuestionPresentation = {
  drafts: Map<string, AsyncQuestionDraft>;
  submit?: (message: string) => Promise<boolean>;
};

export function createAsyncQuestionPresentation(
  state: {
    asyncQuestionScope?: string;
    asyncQuestionDrafts: Map<string, AsyncQuestionDraft>;
    transcriptRenderContext: { onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"] };
  },
  props: {
    sessionKey: string;
    currentAgentId?: string;
    connectionEpoch?: number;
    onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"];
  },
): AsyncQuestionPresentation {
  const scope = JSON.stringify([props.sessionKey, props.currentAgentId, props.connectionEpoch]);
  if (state.asyncQuestionScope !== scope) {
    state.asyncQuestionScope = scope;
    state.asyncQuestionDrafts = new Map();
  }
  const drafts = state.asyncQuestionDrafts;
  return {
    drafts,
    submit: props.onAsyncQuestionSubmit
      ? async (message) => {
          if (state.asyncQuestionScope !== scope || state.asyncQuestionDrafts !== drafts) {
            return false;
          }
          return (await state.transcriptRenderContext.onAsyncQuestionSubmit?.(message)) === true;
        }
      : undefined,
  };
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0;
}

export function readAsyncQuestions(message: unknown): AsyncQuestions | null {
  if (!isRecord(message) || message.role !== "assistant") {
    return null;
  }
  const metadata = message.openclawAsyncDelivery;
  if (
    !isRecord(metadata) ||
    !boundedText(metadata.itemId, 256) ||
    !Array.isArray(metadata.questions) ||
    metadata.questions.length === 0 ||
    metadata.questions.length > 12
  ) {
    return null;
  }
  const questions: AsyncQuestions["questions"] = [];
  for (const question of metadata.questions) {
    if (
      !isRecord(question) ||
      !boundedText(question.title, 4096) ||
      (question.options !== undefined &&
        (!Array.isArray(question.options) ||
          question.options.length === 0 ||
          question.options.length > 4 ||
          !question.options.every((option) => boundedText(option, 256))))
    ) {
      return null;
    }
    questions.push({ title: question.title, options: question.options });
  }
  return { itemId: metadata.itemId, questions };
}

function quoteQuestion(title: string): string {
  const encoder = new TextEncoder();
  let quote = "";
  let bytes = 0;
  for (const character of title) {
    bytes += encoder.encode(character).length;
    if (bytes > 512) {
      break;
    }
    quote += character;
  }
  return `> ${quote.replace(/[\r\n]/g, " ")}`;
}

class ChatAsyncQuestion extends OpenClawLightDomElement {
  @property({ attribute: false }) questions?: AsyncQuestions;
  @property({ attribute: false }) presentation?: AsyncQuestionPresentation;

  override render() {
    const { questions, presentation } = this;
    if (!questions || !presentation) {
      return nothing;
    }
    let draft = presentation.drafts.get(questions.itemId);
    if (!draft) {
      draft = {
        answers: Object.fromEntries(
          questions.questions.map((question, index) => [
            String(index),
            (question.options ?? []).slice(0, 1),
          ]),
        ),
      };
      presentation.drafts.set(questions.itemId, draft);
    }
    const currentDraft = draft;
    if (draft.status === "submitted" || draft.status === "skipped") {
      return html`<div class="chat-question-summary" role="status">
        ${questions.questions.map(
          (question, index) => html`<div>
            <strong>${question.title}</strong>
            <div>
              ${draft.status === "skipped" ? t("chat.questions.skipped") : draft.answers[String(index)]?.join(", ")}
            </div>
          </div>`,
        )}
      </div>`;
    }
    return keyed(
      presentation.drafts,
      html`<openclaw-chat-question-panel
        .props=${{
          model: {
            requestKey: questions.itemId,
            title: t("chat.questions.eyebrow"),
            questions: questions.questions.map((question, index) => ({
              questionId: String(index),
              header: question.options ? question.title : t("chat.questions.answer"),
              question: question.title,
              options: (question.options ?? []).map((label) => ({ label })),
              isOther: true,
            })),
            autoFocus: false,
            collapsed: false,
            disabled: !presentation.submit,
            submitting: draft.status === "submitting",
            answersById: draft.answers,
            error: draft.error,
          },
          onAnswersChange: (answers: Record<string, string[]>) => {
            currentDraft.answers = answers;
          },
          onSkip: () => {
            currentDraft.status = "skipped";
            this.requestUpdate();
          },
          onSubmit: async (answers: Record<string, string[]>) => {
            currentDraft.status = "submitting";
            currentDraft.error = undefined;
            this.requestUpdate();
            const message = questions.questions
              .map(
                (question, index) =>
                  `${quoteQuestion(question.title)}\n\n${answers[String(index)]?.join(", ") ?? ""}`,
              )
              .join("\n\n");
            try {
              if (!(await presentation.submit?.(message))) {
                throw new Error(t("chat.asyncQuestions.sendFailed"));
              }
              currentDraft.status = "submitted";
            } catch (error) {
              currentDraft.status = undefined;
              currentDraft.error = error instanceof Error ? error.message : String(error);
              throw error;
            } finally {
              this.requestUpdate();
            }
          },
        }}
      ></openclaw-chat-question-panel>`,
    );
  }
}

customElements.define("openclaw-chat-async-question", ChatAsyncQuestion);
