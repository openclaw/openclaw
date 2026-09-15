// Cached channel messages outlive the transcript branch they were consumed into:
// a rewind or branch switch rotates the session to a new leaf, but channel caches
// key on chat identity and keep serving the cut turns. These probes let the
// inbound context merge drop cached window entries whose transcript turn is no
// longer on the active path, without touching the cache itself.
//
// Every check is candidate-scoped: the prepared window's own identities drive a
// handful of indexed point reads against the active-path projection, so a turn
// costs proportionally to the window being merged, never to the discarded
// history behind it. A healthy projection with zero active events is a valid
// empty branch (a rewind before the first message cuts everything); an
// unavailable or cold projection abstains and keeps the entry for this turn.
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
  readSessionTranscriptEntryActiveState,
  readSessionTransportMessageInactiveState,
} from "./session-accessor.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";

type InactiveProbeScope = {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
};

function resolveProbeScope(params: InactiveProbeScope) {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
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
    return undefined;
  }
  const agentId = requestedAgentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const scopedSessionKey = scopeLegacySessionKeyToAgent({ agentId, sessionKey }) ?? sessionKey;
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(agentId);
  const entry = loadSessionEntryReadOnly({ agentId, sessionKey: scopedSessionKey, storePath });
  if (!entry?.sessionId) {
    return undefined;
  }
  return { agentId, sessionId: entry.sessionId, sessionKey: scopedSessionKey, storePath };
}

/** True when a rewind or branch switch cut this transcript entry from the active path. */
export async function isInactiveTranscriptEntry(
  params: InactiveProbeScope,
  entryId: string,
): Promise<boolean> {
  const scope = resolveProbeScope(params);
  const id = normalizeOptionalString(entryId);
  if (!scope || !id) {
    return false;
  }
  try {
    return readSessionTranscriptEntryActiveState(scope, id) === false;
  } catch (error) {
    // The projection rebuild is already scheduled; the next turn prunes. A cold
    // transcript is not restored just to filter a chat window.
    if (
      isSessionTranscriptProjectionUnavailableError(error) ||
      error instanceof SessionTranscriptColdError
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * True when a cached transport message (channel-agnostic, keyed by the exact
 * conversation) belongs to a turn cut from the active path. An entry whose
 * provenance cannot be established returns false and is retained, because
 * transport ids repeat across conversations.
 */
export async function isInactiveTransportMessage(
  params: InactiveProbeScope,
  message: { conversationRef?: string; messageId?: string },
): Promise<boolean> {
  const scope = resolveProbeScope(params);
  const conversationRef = normalizeOptionalString(message.conversationRef);
  const messageId = normalizeOptionalString(message.messageId);
  if (!scope || !conversationRef || !messageId) {
    return false;
  }
  try {
    return readSessionTransportMessageInactiveState(scope, { conversationRef, messageId });
  } catch (error) {
    if (
      isSessionTranscriptProjectionUnavailableError(error) ||
      error instanceof SessionTranscriptColdError
    ) {
      return false;
    }
    throw error;
  }
}
