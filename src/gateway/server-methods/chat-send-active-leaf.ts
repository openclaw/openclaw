import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import type { GatewaySessionEntryRead } from "../session-utils.js";

export const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function assertExpectedLeafActive(
  session: Pick<GatewaySessionEntryRead, "canonicalKey" | "entry" | "storePath"> & {
    transcript?: SessionTranscriptAnchorFacts;
  },
  expectedLeafEntryId: string | null,
  requestedSessionId: string | undefined,
  options?: { allowEmptyAncestor?: boolean },
) {
  const activePathRelation =
    session.transcript?.activePathRelation ??
    (session.entry?.sessionId ? undefined : expectedLeafEntryId === null ? "exact" : "off-path");
  if (activePathRelation === undefined) {
    throw new Error("Chat admission omitted its worker-prepared active path");
  }
  // Branch switches preserve entry ids while rotating session ids. A supplied session id
  // fences exact and ancestor matches; message admission also accepts an unpinned prefix.
  const matchesRequestedSession =
    requestedSessionId === undefined || requestedSessionId === session.entry?.sessionId;
  // Only message admission treats an empty view as a prefix after new appends.
  const matchesActivePath =
    activePathRelation === "exact" ||
    ((requestedSessionId !== undefined || options?.allowEmptyAncestor === true) &&
      (activePathRelation === "ancestor" ||
        (options?.allowEmptyAncestor === true && expectedLeafEntryId === null)));
  if (!matchesRequestedSession || !matchesActivePath) {
    throw new Error(ACTIVE_LEAF_CHANGED_ERROR_REASON);
  }
}
