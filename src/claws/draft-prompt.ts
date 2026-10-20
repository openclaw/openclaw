import { clawDraftRelativePath } from "./draft.js";

export function clawDraftPrompt(draftId: string): string {
  return `/skill create-claw Turn this agent into a shareable Claw. Draft: ${clawDraftRelativePath(draftId)}.`;
}
