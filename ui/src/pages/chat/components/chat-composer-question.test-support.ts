import { solidContent } from "../../../lit/solid-content.tsx";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import type { QuestionPanelProps } from "./chat-question-card.ts";

export function renderComposerQuestionDock(panel: QuestionPanelProps | null) {
  return solidContent(ComposerQuestionDock, { panel });
}
