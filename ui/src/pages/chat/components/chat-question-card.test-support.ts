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
  // Join the native lazy import before polling its committed DOM.
  await customElements.whenDefined("openclaw-chat-question-panel");
  const panel = await waitForSolid(() => {
    // Plugin replacement can retire the original card while its import is pending.
    const current = container.querySelector<ChatQuestionCard>("openclaw-chat-question-card");
    const loaded = current?.querySelector<ChatQuestionPanel>("openclaw-chat-question-panel");
    if (!loaded) {
      throw new Error("Expected a loaded question panel");
    }
    return loaded;
  });
  await panel.updateComplete;
  return panel;
}
