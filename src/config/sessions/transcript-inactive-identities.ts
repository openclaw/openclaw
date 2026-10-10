// Cached channel messages outlive the transcript branch they were consumed into.
// A rewind or branch switch rotates the active leaf but leaves the channel cache
// keyed by chat. These probes let the inbound merge drop cached window entries
// whose turn is no longer on the active path, without touching the cache or
// matching rendered text.
//
// Each check is one indexed point read. A healthy projection with zero active
// events is a valid empty branch. An unavailable or cold projection abstains.
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import {
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

function abstainOnUnavailableProjection(error: unknown): boolean {
  return (
    isSessionTranscriptProjectionUnavailableError(error) ||
    error instanceof SessionTranscriptColdError
  );
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
    if (abstainOnUnavailableProjection(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * True when a cached transport message belongs to a source turn cut from the
 * active path. The id is the exact `channel-user:v1:<hash>` the ordinary
 * ingress writer persisted. An entry whose origin cannot be established
 * returns false and is retained, because transport ids repeat across chats.
 */
export async function isInactiveTransportMessage(
  params: InactiveProbeScope,
  message: {
    provider?: string;
    accountId?: string;
    conversationId?: string;
    messageId?: string;
  },
): Promise<boolean> {
  const scope = resolveProbeScope(params);
  const sourceTurnId = buildChannelSourceTurnId(message);
  if (!scope || !sourceTurnId) {
    return false;
  }
  try {
    return readSessionTransportMessageInactiveState(scope, { sourceTurnId });
  } catch (error) {
    if (abstainOnUnavailableProjection(error)) {
      return false;
    }
    throw error;
  }
}
