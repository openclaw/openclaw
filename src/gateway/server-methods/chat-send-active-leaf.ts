import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { GatewaySessionEntryRead } from "../session-utils.js";

export const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

/**
 * A send continues the branch its sender saw. It is admitted while the sender's leaf is
 * still on the active path: the exact leaf, an ancestor that later appends extended, or an
 * empty view. A rewind, branch switch or reset away from that leaf refuses it. Stop acts
 * before send admission, so it also refuses a reset away from the sender's `requestedSessionId`.
 */
export function assertExpectedLeafActive(
  session: Pick<GatewaySessionEntryRead, "canonicalKey" | "entry" | "storePath"> & {
    transcript?: SessionTranscriptAnchorFacts;
  },
  expectedLeafEntryId: string | null,
  requestedSessionId?: string,
) {
  const onActivePath =
    session.transcript?.onActivePath ??
    (session.entry?.sessionId ? undefined : expectedLeafEntryId === null);
  if (onActivePath === undefined) {
    throw new Error("Chat admission omitted its worker-prepared active path");
  }
  if (
    !onActivePath ||
    (requestedSessionId !== undefined && requestedSessionId !== session.entry?.sessionId)
  ) {
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

/** Read the current row and active path in one existing worker snapshot before a Stop effect. */
export async function assertExpectedLeafActiveAsync(
  session: Pick<GatewaySessionEntryRead, "canonicalKey" | "entry" | "storePath">,
  agentId: string,
  expectedLeafEntryId: string | null,
  requestedSessionId: string | undefined,
): Promise<void> {
  if (isIncognitoSessionKey(session.canonicalKey)) {
    const transcript = await readIncognitoActivePath(session, agentId, expectedLeafEntryId);
    assertExpectedLeafActive({ ...session, transcript }, expectedLeafEntryId, requestedSessionId);
    return;
  }
  await withSessionEntriesFromStoresInWorker(
    [
      {
        agentId,
        storePath: session.storePath,
        sessionKeys: [session.canonicalKey],
        transcript: {
          sessionKey: session.canonicalKey,
          agentId,
          entryIds: [],
          activePathEntryId: expectedLeafEntryId,
        },
      },
    ],
    ([owner]) => {
      owner!.assertCurrent();
      assertExpectedLeafActive(
        {
          canonicalKey: session.canonicalKey,
          storePath: session.storePath,
          entry: owner!.result.entries[0]?.entry,
          transcript: owner!.result.transcript,
        },
        expectedLeafEntryId,
        requestedSessionId,
      );
    },
    { ordered: true },
  );
}
