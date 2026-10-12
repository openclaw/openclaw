import { readSessionTranscriptActivePathEntryRelation } from "../../config/sessions/session-accessor.js";
import type { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils.js";

export const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function assertExpectedLeafActive(
  session: Pick<
    Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
    "canonicalKey" | "entry" | "storePath"
  >,
  agentId: string,
  expectedLeafEntryId: string | null,
  requestedSessionId: string | undefined,
  options?: { allowEmptyAncestor?: boolean },
) {
  const activePathRelation = session.entry?.sessionId
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
      : "off-path";
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
