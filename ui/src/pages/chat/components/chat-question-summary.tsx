import { For, Show } from "solid-js";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { QuestionPanelQuestion } from "./chat-question-types.ts";

export function terminalAnswer(prompt: QuestionPrompt, question: QuestionPanelQuestion): string {
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
  return (
    answer ||
    t(prompt.answeredElsewhere ? "chat.questions.answeredElsewhere" : "chat.questions.answered")
  );
}

export function ChatQuestionSummary(props: { prompt: QuestionPrompt }) {
  return (
    <Show when={props.prompt.status !== "pending"}>
      <div class="chat-question-summary" aria-label={t("chat.questions.summaryLabel")}>
        <For each={props.prompt.questions}>
          {(question) => (
            <div class="chat-question-summary__item">
              <div class="chat-question-summary__prompt">{question.question}</div>{" "}
              <div class="chat-question-summary__line">
                <strong>{question.header}:</strong>{" "}
                <span>{terminalAnswer(props.prompt, question)}</span>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
