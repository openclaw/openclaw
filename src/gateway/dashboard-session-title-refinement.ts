import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionTitleSource,
  SESSION_TITLE_SOURCE_MAX_CHARS,
} from "../sessions/session-title-source.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import type { SkillCommandSpec } from "../skills/types.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { matchesGeneratedSessionTitle } from "./session-title-state.js";
import {
  readSessionTranscriptBoundedMessageTailPageAsync,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

export async function claimDashboardTitleRefinement(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
  commitGuard?: SessionSourceAssertion;
}): Promise<string | undefined> {
  let claimed: string | undefined;
  await patchSessionEntryCore(
    {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey: resolveStoredSessionKeyForAgentStore(params),
    },
    (current) => {
      claimed = undefined;
      const state = current.titleRefinement;
      if (
        current.sessionId !== params.sessionId ||
        !state ||
        state.remainingMessages <= 0 ||
        !matchesGeneratedSessionTitle(current, state.generatedName)
      ) {
        return null;
      }
      const remainingMessages = state.remainingMessages - 1;
      // Claim before inference; a failed attempt leaves the existing name and is not retried.
      if (!remainingMessages) {
        claimed = state.generatedName;
      }
      return { titleRefinement: { ...state, remainingMessages } };
    },
    { requireWriteSuccess: true, ...sessionEntryCommitGuardOptions(params.commitGuard) },
  );
  return claimed;
}

export async function readDashboardRefinementSource(
  scope: SessionTranscriptReadScope,
  currentMessage: string,
  skillCommands: SkillCommandSpec[],
): Promise<string> {
  const page = await readSessionTranscriptBoundedMessageTailPageAsync(scope, {
    maxMessages: 40,
    maxBytes: 32_000,
    offset: 0,
  });
  const messages = page.events.flatMap(({ event }) => {
    const message = asOptionalRecord(asOptionalRecord(event)?.message);
    const text = message?.role === "user" ? extractFirstTextBlock(message) : undefined;
    const source = text ? resolveSessionTitleSource(text, skillCommands) : undefined;
    return source ? [source] : [];
  });
  // The accepted current turn may not have reached transcript storage yet.
  return truncateUtf16Safe(
    ["Latest task:", currentMessage, "Recent context:", ...messages.slice(-6)].join("\n"),
    SESSION_TITLE_SOURCE_MAX_CHARS,
  );
}
