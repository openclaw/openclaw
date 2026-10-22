import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatQuestionCard } from "./chat-question-card.ts";
import type { ChatQuestionPanel } from "./chat-question-panel.tsx";

/** Wait for the card's native lazy boundary without starting its import. */
export async function questionPanelIn(container: ParentNode): Promise<ChatQuestionPanel> {
  const card = container.querySelector<ChatQuestionCard>("openclaw-chat-question-card");
  if (!card) {
    throw new Error("Expected a question card");
  }
  await card.updateComplete;
  const panel = await waitForSolid(() => {
    const loaded = card.querySelector<ChatQuestionPanel>("openclaw-chat-question-panel");
    if (!loaded) {
      throw new Error("Expected a loaded question panel");
    }
    return loaded;
  });
  await panel.updateComplete;
  return panel;
}
