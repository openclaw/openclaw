import { readSessionTranscriptActivePathEntryRelation } from "../../config/sessions/session-accessor.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { loadSessionEntry } from "../session-utils.js";

export const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function assertExpectedLeafActive(
  session: Pick<ReturnType<typeof loadSessionEntry>, "canonicalKey" | "entry" | "storePath"> & {
    transcript?: SessionTranscriptAnchorFacts;
  },
  agentId: string,
  expectedLeafEntryId: string | null,
  requestedSessionId: string | undefined,
  options?: { allowEmptyAncestor?: boolean },
) {
  const activePathRelation =
    session.transcript?.activePathRelation ??
    (session.entry?.sessionId
      ? isIncognitoSessionKey(session.canonicalKey)
        ? readSessionTranscriptActivePathEntryRelation(
            {
              agentId,
              sessionId: session.entry.sessionId,
              sessionKey: session.canonicalKey,
              sessionEntry: session.entry,
              storePath: session.storePath,
            },
            expectedLeafEntryId,
          )
        : undefined
      : expectedLeafEntryId === null
        ? "exact"
        : "off-path");
  if (activePathRelation === undefined) {
    throw new Error("Chat admission omitted its worker-prepared active path");
  }
  // Branch switches preserve entry ids while rotating session ids. A supplied session id
  // fences exact and ancestor matches; omission remains legacy exact-only compatibility.
  const matchesRequestedSession =
    requestedSessionId === undefined || requestedSessionId === session.entry?.sessionId;
  // Only message admission treats a pinned empty root as an ancestor.
  const matchesActivePath =
    activePathRelation === "exact" ||
    (requestedSessionId !== undefined &&
      (activePathRelation === "ancestor" ||
        (options?.allowEmptyAncestor === true && expectedLeafEntryId === null)));
  if (!matchesRequestedSession || !matchesActivePath) {
    throw new Error(ACTIVE_LEAF_CHANGED_ERROR_REASON);
  }
}

/** Read the current row and active path in one existing worker snapshot before a Stop effect. */
export async function assertExpectedLeafActiveAsync(
  session: Pick<ReturnType<typeof loadSessionEntry>, "canonicalKey" | "entry" | "storePath">,
  agentId: string,
  expectedLeafEntryId: string | null,
  requestedSessionId: string | undefined,
  options?: { allowEmptyAncestor?: boolean },
): Promise<void> {
  if (isIncognitoSessionKey(session.canonicalKey)) {
    assertExpectedLeafActive(session, agentId, expectedLeafEntryId, requestedSessionId, options);
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
        agentId,
        expectedLeafEntryId,
        requestedSessionId,
        options,
      );
    },
    { ordered: true },
  );
}
