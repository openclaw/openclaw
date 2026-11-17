import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import type { GatewaySessionEntryRead } from "../session-utils.js";

export const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

/**
 * What a sender saw must be a prefix of the active path: its leaf, or an ancestor that later
 * appends extended. An empty view is a prefix of every path. A rewind, branch switch or reset
 * away from the leaf leaves it off the path and refuses the send.
 */
export function assertExpectedLeafActive(
  session: Pick<GatewaySessionEntryRead, "canonicalKey" | "entry" | "storePath"> & {
    transcript?: SessionTranscriptAnchorFacts;
  },
  expectedLeafEntryId: string | null,
) {
  const onActivePath =
    expectedLeafEntryId === null ||
    (session.entry?.sessionId ? session.transcript?.onActivePath : false);
  if (onActivePath === undefined) {
    throw new Error("Chat admission omitted its worker-prepared active path");
  }
  if (!onActivePath) {
    throw new Error(ACTIVE_LEAF_CHANGED_ERROR_REASON);
  }
}

/**
 * Incognito transcripts live in the process-local session actor, which read workers cannot
 * open. This read precedes the caller's entry snapshot; its session-id fence rejects resets, and
 * an append landing between the two reads is an accepted, retryable race.
 */
export async function readIncognitoActivePath(
  session: Pick<GatewaySessionEntryRead, "canonicalKey" | "entry" | "storePath">,
  agentId: string,
  expectedLeafEntryId: string | null,
): Promise<SessionTranscriptAnchorFacts | undefined> {
  const sessionId = session.entry?.sessionId;
  if (!sessionId) {
    return undefined;
  }
  return readSessionTranscriptAnchorsAsync(
    { agentId, sessionId, sessionKey: session.canonicalKey, storePath: session.storePath },
    { entryIds: [], activePathEntryId: expectedLeafEntryId },
  );
}
