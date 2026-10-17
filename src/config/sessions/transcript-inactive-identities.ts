// Cached channel messages outlive the transcript branch they were consumed into.
// A rewind or branch switch rotates the active leaf but leaves the channel cache
// keyed by chat. These probes let the inbound merge drop cached window entries
// whose turn is no longer on the active path, without touching the cache or
// matching rendered text.
//
// Each check is one indexed point read on the existing session history worker.
// A healthy projection with zero active events is a valid empty branch. An
// unavailable or cold projection abstains.
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../../routing/session-key.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-accessor.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import type { SessionTranscriptInactiveIdentityProbe } from "./session-transcript-worker-read.types.js";

type InactiveProbeScope = {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
};

function abstainOnUnavailableProjection(error: unknown): boolean {
  return (
    isSessionTranscriptProjectionUnavailableError(error) ||
    error instanceof SessionTranscriptColdError
  );
}

async function isInactiveRecordedIdentity(
  params: InactiveProbeScope,
  probe: SessionTranscriptInactiveIdentityProbe,
): Promise<boolean> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
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
    return false;
  }
  const agentId = requestedAgentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const scopedSessionKey = scopeLegacySessionKeyToAgent({ agentId, sessionKey }) ?? sessionKey;
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(agentId);
  try {
    const resolved = await withSessionEntryReadOnlyInWorker(
      { agentId, env: process.env, sessionKey: scopedSessionKey, storePath },
      () => {},
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        const sessionId = read.value?.sessionId;
        if (!sessionId) {
          return undefined;
        }
        return {
          env: owner.scope?.env,
          sessionId,
          storePath: owner.source?.path ?? owner.scope?.storePath ?? storePath,
        };
      },
    );
    if (!resolved) {
      return false;
    }
    return await withSessionTranscriptReadSource(
      {
        agentId,
        env: resolved.env,
        sessionEntry: { sessionId: resolved.sessionId },
        sessionId: resolved.sessionId,
        sessionKey: scopedSessionKey,
        storePath: resolved.storePath,
      },
      ({ expectedIdentity, owner, scope }) =>
        owner.readInactiveIdentity({ expectedIdentity, probe, scope }),
    );
  } catch (error) {
    if (abstainOnUnavailableProjection(error)) {
      return false;
    }
    throw error;
  }
}

/** True when a rewind or branch switch cut this transcript entry from the active path. */
export async function isInactiveTranscriptEntry(
  params: InactiveProbeScope,
  entryId: string,
): Promise<boolean> {
  const id = normalizeOptionalString(entryId);
  if (!id) {
    return false;
  }
  return isInactiveRecordedIdentity(params, { kind: "entry", entryId: id });
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
  const sourceTurnId = buildChannelSourceTurnId(message);
  if (!sourceTurnId) {
    return false;
  }
  return isInactiveRecordedIdentity(params, { kind: "transport", sourceTurnId });
}
