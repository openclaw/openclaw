import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionTranscriptReadScope } from "../../gateway/session-transcript-readers.js";
import {
  resolveSessionTitleSource,
  SESSION_TITLE_SOURCE_MAX_CHARS,
} from "../../sessions/session-title-source.js";
import { extractFirstTextBlock } from "../../shared/chat-message-content.js";
import type { SkillCommandSpec } from "../../skills/types.js";

export type ConversationLabelRefinementState = {
  sessionId: string;
  generatedName: string;
  remainingMessages: number;
};

/** Transport owners persist this result before inference, including a failed attempt. */
export function advanceConversationLabelRefinement(params: {
  state: ConversationLabelRefinementState | undefined;
  sessionId: string;
  currentName: string | undefined;
  userMessage: string;
  skillCommands: SkillCommandSpec[];
}): ConversationLabelRefinementState | undefined {
  const { state } = params;
  if (
    !state ||
    state.sessionId !== params.sessionId ||
    state.generatedName !== params.currentName ||
    state.remainingMessages <= 0 ||
    !resolveSessionTitleSource(params.userMessage, params.skillCommands)
  ) {
    return undefined;
  }
  return { ...state, remainingMessages: state.remainingMessages - 1 };
}

export async function readConversationLabelRefinementSource(
  scope: SessionTranscriptReadScope,
  currentMessage: string,
  skillCommands: SkillCommandSpec[],
): Promise<string> {
  const { readSessionTranscriptBoundedMessageTailPageAsync } =
    await import("../../gateway/session-transcript-readers.js");
  const page = await readSessionTranscriptBoundedMessageTailPageAsync(scope, {
    maxMessages: 40,
    maxBytes: 32_000,
    offset: 0,
  });
  const messages = page.events.flatMap(({ event }) => {
    const message = asOptionalRecord(asOptionalRecord(event)?.message);
    const text = message?.role === "user" ? extractFirstTextBlock(message) : undefined;
    if (!text) {
      return [];
    }
    const source = resolveSessionTitleSource(text, skillCommands);
    return source ? [source] : [];
  });
  return truncateUtf16Safe(
    ["Latest task:", currentMessage, "Recent context:", ...messages.slice(-6)].join("\n"),
    SESSION_TITLE_SOURCE_MAX_CHARS,
  );
}
