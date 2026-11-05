import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatGoalDraftMode } from "./chat-types.ts";

/** Browser drafts keep their interpretation with their text, including after reload. */
export function isChatGoalDraftMode(value: unknown): value is ChatGoalDraftMode {
  if (!isRecord(value) || (value.sessionId !== undefined && typeof value.sessionId !== "string")) {
    return false;
  }
  const allowed =
    value.action === "start"
      ? ["action", "sessionId", "commandDraft"]
      : ["action", "sessionId", "goalId", "previousDraft"];
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    ((value.action === "start" &&
      (value.commandDraft === undefined || value.commandDraft === true)) ||
      (value.action === "edit" &&
        typeof value.goalId === "string" &&
        value.goalId.length > 0 &&
        typeof value.previousDraft === "string"))
  );
}

/** Interpret command-backed Goal drafts without rewriting the editable source text. */
export function chatGoalDraftObjective(
  mode: ChatGoalDraftMode | null | undefined,
  draft: string,
): string {
  return mode?.action === "start" && mode.commandDraft
    ? draft.replace(/^\s*\/goal\s+(?:(?:start|set|create)\s)?/iu, "")
    : draft;
}
