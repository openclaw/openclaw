import { solidTemplate } from "./chat-composer-controls.ts";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import type { QuestionPanelProps } from "./chat-question-card.ts";

export function renderComposerQuestionDock(panel: QuestionPanelProps | null) {
  return solidTemplate(ComposerQuestionDock, { panel });
}
