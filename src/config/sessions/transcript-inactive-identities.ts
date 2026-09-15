// Cached channel messages outlive the transcript branch they were consumed into:
// a rewind or branch switch rotates the session to a new leaf, but channel caches
// key on chat identity and keep serving the cut turns. These identities let the
// inbound context merge drop cached window entries whose transcript turn is no
// longer on the active path, without touching the cache itself.
//
// Membership comes from the session's active-path projection, not from decoding
// the transcript: the store anti-join only surfaces events the projection has
// confirmed as cut, so a session that never rewound costs an index scan and no
// payload decoding. A healthy projection with zero active events is a valid
// empty branch (a rewind before the first message discards everything); an
// unavailable or cold projection abstains and keeps the cache for this turn.
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../../routing/session-key.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  loadSessionEntryReadOnly,
  readInactiveSessionTranscriptMessageEvents,
} from "./session-accessor.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";

export type SessionInactiveContextIdentities = {
  /** Entry ids of user/assistant turns cut from the active path. */
  transcriptEntryIds: ReadonlySet<string>;
  /** Keys built by inactiveTransportMessageKey for cut user/assistant turns. */
  transportMessageKeys: ReadonlySet<string>;
};

const EMPTY_IDENTITIES: SessionInactiveContextIdentities = {
  transcriptEntryIds: new Set<string>(),
  transportMessageKeys: new Set<string>(),
};

/** Conversation-scoped identity of one cached transport message. */
export function inactiveTransportMessageKey(params: {
  channel: string;
  conversationRef: string;
  messageId: string;
}): string {
  return `${params.channel.toLowerCase()}${params.conversationRef}${params.messageId}`;
}

export async function readInactiveSessionContextIdentities(params: {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
}): Promise<SessionInactiveContextIdentities> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return EMPTY_IDENTITIES;
  }
  const requestedAgentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  // The canonical read path throws on an explicit/key owner mismatch; abstain
  // here and let that path report it.
  if (
    requestedAgentId &&
    sessionKeyAgentId &&
    requestedAgentId !== normalizeAgentId(sessionKeyAgentId)
  ) {
    return EMPTY_IDENTITIES;
  }
  const agentId = requestedAgentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const scopedSessionKey = scopeLegacySessionKeyToAgent({ agentId, sessionKey }) ?? sessionKey;
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(agentId);
  const entry = loadSessionEntryReadOnly({ agentId, sessionKey: scopedSessionKey, storePath });
  if (!entry?.sessionId) {
    return EMPTY_IDENTITIES;
  }
  let inactive;
  try {
    inactive = readInactiveSessionTranscriptMessageEvents({
      agentId,
      sessionId: entry.sessionId,
      sessionKey: scopedSessionKey,
      storePath,
    });
  } catch (error) {
    // The projection rebuild is already scheduled; the next turn prunes. A cold
    // transcript is not restored just to filter a chat window.
    if (
      isSessionTranscriptProjectionUnavailableError(error) ||
      error instanceof SessionTranscriptColdError
    ) {
      return EMPTY_IDENTITIES;
    }
    throw error;
  }
  const transcriptEntryIds = new Set<string>();
  const transportMessageKeys = new Set<string>();
  for (const { eventId, event } of inactive) {
    transcriptEntryIds.add(eventId);
    const message = asRecord(asRecord(event)?.message);
    const transport = asRecord(asRecord(message?.["__openclaw"])?.transport);
    const channel = normalizeOptionalString(transport?.channel)?.toLowerCase();
    const conversationRef = normalizeOptionalString(transport?.conversationRef);
    const messageId = normalizeOptionalString(transport?.messageId);
    // A turn whose conversation cannot be established is retained rather than
    // matched against an unrelated conversation sharing the session.
    if (!channel || !conversationRef || !messageId) {
      continue;
    }
    transportMessageKeys.add(inactiveTransportMessageKey({ channel, conversationRef, messageId }));
  }
  if (transcriptEntryIds.size === 0 && transportMessageKeys.size === 0) {
    return EMPTY_IDENTITIES;
  }
  return { transcriptEntryIds, transportMessageKeys };
}
