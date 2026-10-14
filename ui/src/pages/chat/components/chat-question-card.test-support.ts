import { ensureCustomElementDefined } from "../../../app/lazy-custom-element.ts";
import type { ChatQuestionCard } from "./chat-question-card.ts";
import type { ChatQuestionPanel } from "./chat-question-panel.tsx";

/** Await the registration owner, then the card and its interactive child. */
export async function questionPanelIn(container: ParentNode): Promise<ChatQuestionPanel> {
  const card = container.querySelector<ChatQuestionCard>("openclaw-chat-question-card");
  if (!card) {
    throw new Error("Expected a question card");
  }
  await card.updateComplete;
  // Join the card's load; starting it here would hide a broken lazy-loading entry point.
  await ensureCustomElementDefined("openclaw-chat-question-panel", async () => {
    throw new Error("Expected the question card to start loading its panel");
  });
  await card.updateComplete;
  const panel = card.querySelector<ChatQuestionPanel>("openclaw-chat-question-panel");
  if (!panel) {
    throw new Error("Expected a loaded question panel");
  }
  await panel.updateComplete;
  return panel;
}
