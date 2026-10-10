import { readSessionTranscriptActivePathEntryRelation } from "../../config/sessions/session-accessor.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import type { loadSessionEntry } from "../session-utils.js";

export const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function assertExpectedLeafActive(
  session: Pick<ReturnType<typeof loadSessionEntry>, "canonicalKey" | "entry" | "storePath">,
  agentId: string,
  expectedLeafEntryId: string | null,
  requestedSessionId: string | undefined,
  options?: {
    allowEmptyAncestor?: boolean;
    preparedRelation?: "exact" | "ancestor" | "off-path";
  },
) {
  const activePathRelation =
    options?.preparedRelation ??
    (session.entry?.sessionId
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
      : expectedLeafEntryId === null
        ? "exact"
        : "off-path");
  // Branch switches preserve entry ids while rotating session ids. A supplied session id
  // fences exact and ancestor matches; omission remains legacy exact-only compatibility.
  const matchesRequestedSession =
    requestedSessionId === undefined || requestedSessionId === session.entry?.sessionId;
  // Only message admission treats a pinned empty root as an ancestor. Stop and
  // recovery commit guards must retain their captured empty view across yields.
  const matchesActivePath =
    activePathRelation === "exact" ||
    (requestedSessionId !== undefined &&
      (activePathRelation === "ancestor" ||
        (options?.allowEmptyAncestor === true && expectedLeafEntryId === null)));
  if (!matchesRequestedSession || !matchesActivePath) {
    throw new Error(ACTIVE_LEAF_CHANGED_ERROR_REASON);
  }
}

/** Prepare the actor path once; effect guards compare its exact current leaf synchronously. */
export async function prepareExpectedLeafActive(
  session: Pick<ReturnType<typeof loadSessionEntry>, "canonicalKey" | "entry" | "storePath">,
  agentId: string,
  expectedLeafEntryId: string | null,
  requestedSessionId: string | undefined,
): Promise<(() => void) | undefined> {
  const source = captureIncognitoSessionSource({
    agentId,
    sessionKey: session.canonicalKey,
    storePath: session.storePath,
  });
  if (!source) return undefined;
  const claim =
    "kind" in source ? undefined : source.actor.sessions.captureCurrent(session.canonicalKey);
  if ("kind" in source || !session.entry) {
    return () => {
      source.admissionSignal?.throwIfAborted();
      if ("kind" in source) source.assertCurrent();
      else source.actor.assertReadable();
      claim?.assertCurrent();
      assertExpectedLeafActive(session, agentId, expectedLeafEntryId, requestedSessionId, {
        preparedRelation: expectedLeafEntryId === null ? "exact" : "off-path",
      });
    };
  }
  const { actor } = source;
  const assertCurrent = () => {
    source.admissionSignal?.throwIfAborted();
    actor.assertReadable();
    claim?.assertCurrent();
  };
  const prepared = await actor.sessions.history(
    { assertCurrent },
    {
      type: "session.history.active-path-relation",
      input: {
        sessionKey: session.canonicalKey,
        sessionId: session.entry.sessionId,
        lifecycleRevision: session.entry.lifecycleRevision,
        entryId: expectedLeafEntryId,
      },
    },
  );
  return () => {
    assertCurrent();
    if (actor.sessions.readActiveLeaf(session.canonicalKey) !== prepared.activeLeafEntryId) {
      throw new Error(ACTIVE_LEAF_CHANGED_ERROR_REASON);
    }
    assertExpectedLeafActive(session, agentId, expectedLeafEntryId, requestedSessionId, {
      preparedRelation: prepared.relation,
    });
  };
}
